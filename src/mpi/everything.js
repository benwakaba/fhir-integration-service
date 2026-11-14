// Patient/$everything over the golden record: one Bundle holding the golden
// Patient and every resource in every linked source's patient compartment.
//
//  - Patient references are rewritten to the golden Patient; each entry's fullUrl
//    is its source-scoped URL on this service, so its other relative references
//    ('Encounter/123') still resolve within the right source.
//  - The same clinical fact delivered by two sources appears once: the copy from
//    the best-ranked source (most recently updated, then source priority) is kept.
//  - An OperationOutcome entry (search.mode = outcome) reports the merge: counts
//    per source, duplicates removed, and demographic conflicts in the golden record.

import { config } from '../config.js';
import { canonicalJson } from '../fhir/canonical.js';
import { isLocal, parseReference } from '../fhir/references.js';
import { facadeUrl, present, presentGolden } from '../fhir/present.js';
import { normalizeCoding } from '../terminology/systems.js';
import { LINKED_COMPARTMENTS, loadPatient } from '../query/linked.js';

export async function everything(db, masterId, { types = null, since = null, count = 1000, offset = 0 } = {}) {
  const { master, links } = await loadPatient(db, masterId);
  const { rows } = await db.query(
    `SELECT o.*, s.base_url, s.priority
     FROM resources o ${LINKED_COMPARTMENTS}
     JOIN sources s ON s.id = o.source_id
     WHERE NOT o.deleted AND o.resource_type <> 'Patient'
       AND ($2::text[] IS NULL OR o.resource_type = ANY($2))
       AND ($3::timestamptz IS NULL OR o.updated_at >= $3)
     ORDER BY o.last_updated DESC NULLS LAST, s.priority, o.id`,
    [masterId, types, since],
  );

  const goldenUrl = `${config.publicBaseUrl}/fhir/golden/Patient/${masterId}`;
  const linkedIds = new Map(); // source -> Set(patient fhir ids)
  for (const l of links) {
    if (!linkedIds.has(l.source_id)) linkedIds.set(l.source_id, new Set());
    linkedIds.get(l.source_id).add(l.fhir_id);
  }

  const kept = [];
  const seen = new Map(); // fingerprint -> kept row
  const duplicates = [];
  for (const row of rows) {
    const prints = fingerprints(row.resource);
    const original = prints.map((p) => seen.get(p)).find((r) => r && r.source_id !== row.source_id);
    if (original) {
      duplicates.push({ dropped: `${row.source_id}/${row.resource_type}/${row.fhir_id}`, kept: `${original.source_id}/${original.resource_type}/${original.fhir_id}` });
      continue;
    }
    for (const p of prints) if (!seen.has(p)) seen.set(p, row);
    kept.push(row);
  }

  const perSource = {};
  for (const row of kept) perSource[row.source_id] = (perSource[row.source_id] ?? 0) + 1;
  const page = kept.slice(offset, offset + count);
  const entries = page.map((row) => {
    const resource = rewritePatientRefs(present(row, row), row, linkedIds, goldenUrl);
    return { fullUrl: facadeUrl(row.source_id, row.resource_type, row.fhir_id), resource, search: { mode: 'match' } };
  });

  const selfUrl = `${goldenUrl}/$everything`;
  const next = offset + count < kept.length ? `${selfUrl}?_count=${count}&_offset=${offset + count}` : null;
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: kept.length + 1,
    link: [{ relation: 'self', url: `${selfUrl}?_count=${count}&_offset=${offset}` }, ...(next ? [{ relation: 'next', url: next }] : [])],
    entry: [
      ...(offset === 0 ? [{ fullUrl: goldenUrl, resource: presentGolden(master), search: { mode: 'match' } }] : []),
      ...entries,
      { resource: mergeOutcome(master, links, perSource, duplicates), search: { mode: 'outcome' } },
    ],
  };
}

/**
 * Keys under which two sources' copies of the same fact collide: shared business
 * identifiers, or (for results and problems without one) what was measured/diagnosed,
 * when, and the value.
 */
export function fingerprints(resource) {
  const type = resource.resourceType;
  const prints = (resource.identifier ?? [])
    .filter((i) => i.system && i.value)
    .map((i) => `${type}|id|${i.system}|${i.value}`);
  const codes = (resource.code?.coding ?? []).map((c) => normalizeCoding(c)).map((n) => `${n.system}|${n.code}`).sort().join(',');
  if (type === 'Observation' && codes) {
    const when = Date.parse(resource.effectiveDateTime ?? resource.effectiveInstant ?? resource.effectivePeriod?.start ?? '');
    const value = resource.valueQuantity
      ? `${resource.valueQuantity.value}${resource.valueQuantity.code ?? resource.valueQuantity.unit ?? ''}`
      : canonicalJson(resource.valueCodeableConcept ?? resource.valueString ?? resource.component ?? null);
    if (Number.isFinite(when)) prints.push(`${type}|${codes}|${Math.floor(when / 60_000)}|${value}`);
  }
  if (type === 'Condition' && codes) {
    const onset = (resource.onsetDateTime ?? resource.onsetPeriod?.start ?? resource.recordedDate ?? '').slice(0, 10);
    if (onset) prints.push(`${type}|${codes}|${onset}`);
  }
  return prints;
}

function rewritePatientRefs(resource, row, linkedIds, goldenUrl) {
  const ids = linkedIds.get(row.source_id) ?? new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (typeof node.reference === 'string') {
      const ref = parseReference(node.reference);
      if (ref?.type === 'Patient' && isLocal(ref, row.base_url) && ids.has(ref.id)) node.reference = goldenUrl;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(resource);
  return resource;
}

function mergeOutcome(master, links, perSource, duplicates) {
  const issue = [
    {
      severity: 'information',
      code: 'informational',
      diagnostics: `Merged ${links.length} source record(s): ${Object.entries(perSource).map(([s, n]) => `${n} from ${s}`).join(', ') || 'no clinical resources'}`,
    },
  ];
  if (duplicates.length) {
    issue.push({
      severity: 'information',
      code: 'duplicate',
      diagnostics: `${duplicates.length} cross-source duplicate(s) removed: ${duplicates.slice(0, 20).map((d) => `${d.dropped} (kept ${d.kept})`).join('; ')}`,
    });
  }
  for (const c of master.conflicts ?? []) {
    issue.push({
      severity: c.severity === 'high' && !c.resolvedBy ? 'warning' : 'information',
      code: 'conflict',
      diagnostics: `Sources disagree on ${c.element}; ${c.resolvedBy ? 'resolved by steward override' : `kept the value from ${c.rule}`}: ${c.candidates.map((x) => `${x.source}=${JSON.stringify(x.value)}`).join(', ')}`,
      expression: [`Patient.${c.element.split(':')[0]}`],
    });
  }
  return { resourceType: 'OperationOutcome', issue };
}

// Observations for a golden patient, resolved through the terminology layer and
// normalized. The caller asks for 'hba1c' and gets every result that means HbA1c
// (any of its LOINC codes, any system alias, from every linked source), in one unit.

import { dateRange } from '../fhir/dates.js';
import { conceptsFor, exactCodes, getConcept } from '../terminology/concepts.js';
import { normalizeCoding } from '../terminology/systems.js';
import { toCanonical } from '../terminology/units.js';
import { LINKED_COMPARTMENTS } from './linked.js';

/**
 * @param concepts concept ids, or null for every mapped observation
 */
export async function findObservations(db, masterId, { concepts = null, since = null, until = null, limit = 100 } = {}) {
  const wanted = concepts ? new Set(concepts) : null;
  const params = [masterId, since, until];
  let prefilter = '';
  if (wanted) {
    // GIN pre-filter on the code alone (system-agnostic, so aliased systems still
    // match), as a top-level code or a component code (blood pressure panels).
    // The exact system check happens below, after normalization.
    const patterns = [...wanted].flatMap((id) => exactCodes(getConcept(id))).flatMap((code) => [
      { code: { coding: [{ code }] } },
      { component: [{ code: { coding: [{ code }] } }] },
    ]);
    prefilter = `AND (${patterns.map((p) => { params.push(JSON.stringify(p)); return `o.resource @> $${params.length}::jsonb`; }).join(' OR ')})`;
  }
  const { rows } = await db.query(
    `SELECT o.source_id, o.fhir_id, o.version_id, o.resource
     FROM resources o ${LINKED_COMPARTMENTS}
     JOIN sources s ON s.id = o.source_id
     WHERE o.resource_type = 'Observation' AND NOT o.deleted
       AND ($2::timestamptz IS NULL OR COALESCE(o.effective_end, 'infinity') >= $2)
       AND ($3::timestamptz IS NULL OR o.effective_start < $3)
       ${prefilter}
     ORDER BY o.effective_start DESC NULLS LAST, o.last_updated DESC NULLS LAST, s.priority, o.id`,
    params,
  );

  const facts = [];
  const unmapped = new Map();
  for (const row of rows) {
    const found = observationFacts(row.resource, wanted).map((f) => ({ id: `${row.source_id}/Observation/${row.fhir_id}`, source: row.source_id, ...f }));
    facts.push(...found);
    if (!wanted && !found.length) {
      for (const c of row.resource.code?.coding ?? []) {
        const n = normalizeCoding(c);
        const key = `${n.system}|${n.code}`;
        unmapped.set(key, { system: n.system, code: n.code, display: c.display, count: (unmapped.get(key)?.count ?? 0) + 1 });
      }
    }
  }
  const unique = dedupeAcrossSources(facts);
  return {
    count: unique.length,
    observations: unique.slice(0, limit),
    ...(!wanted && { unmapped: [...unmapped.values()].sort((a, b) => b.count - a.count).slice(0, 20) }),
  };
}

/**
 * The same result delivered by two sources is one fact. Rows arrive ordered by
 * effective time, then the same ranking survivorship uses (most recently updated
 * record, then source priority), so the kept copy is the best-ranked one and the
 * others are listed in alsoReportedBy. Comparing normalized values means 5.9 %
 * and 41 mmol/mol of the same draw also collapse.
 */
export function dedupeAcrossSources(facts) {
  const kept = new Map();
  const out = [];
  for (const fact of facts) {
    const when = Date.parse(fact.effective ?? '');
    const key = fact.value !== null && Number.isFinite(when) ? `${fact.concept}|${fact.component ?? ''}|${Math.floor(when / 60_000)}|${fact.value}` : null;
    const first = key && kept.get(key);
    if (first && first.source !== fact.source) {
      (first.alsoReportedBy ??= []).push(fact.id);
      continue;
    }
    if (key && !first) kept.set(key, fact);
    out.push(fact);
  }
  return out;
}

/** Normalized facts in one Observation: its own code, and each component (BP panels). */
export function observationFacts(resource, wanted = null) {
  const facts = [];
  for (const { concept, coding } of matchCodeable(resource.code, wanted)) {
    facts.push(fact(resource, concept, coding, resource));
  }
  (resource.component ?? []).forEach((component, index) => {
    for (const { concept, coding } of matchCodeable(component.code, wanted)) {
      facts.push({ ...fact(resource, concept, coding, component), component: index });
    }
  });
  return facts;
}

function matchCodeable(codeable, wanted) {
  const matches = new Map();
  for (const coding of codeable?.coding ?? []) {
    const n = normalizeCoding(coding);
    for (const { concept } of conceptsFor(n.system, n.code)) {
      if (concept.domain !== 'observation' || (wanted && !wanted.has(concept.id)) || matches.has(concept.id)) continue;
      matches.set(concept.id, { concept, coding: { system: n.system, code: n.code, display: coding.display } });
    }
  }
  return [...matches.values()];
}

function fact(resource, concept, coding, holder) {
  const quantity = holder.valueQuantity ?? quantityFromString(holder.valueString);
  const normalized = quantity ? toCanonical(quantity, concept) : { value: null, reason: 'no-numeric-value' };
  return {
    concept: concept.id,
    code: coding,
    effective: effectiveOf(resource),
    status: resource.status ?? null,
    value: normalized.value,
    unit: normalized.value === null ? null : concept.unit,
    ...(normalized.comparator && { comparator: normalized.comparator }),
    original: quantity ? { value: quantity.value, unit: quantity.code ?? quantity.unit ?? null } : originalValue(holder),
    ...(normalized.conversion && { conversion: normalized.conversion }),
    ...(normalized.value === null && { notNormalized: normalized.reason, ...(normalized.sourceUnit && { sourceUnit: normalized.sourceUnit }) }),
    ...(holder.valueString !== undefined && quantity && { parsedFromString: true }),
    ...(holder.dataAbsentReason && { dataAbsentReason: holder.dataAbsentReason.coding?.[0]?.code ?? holder.dataAbsentReason.text }),
    ...(interpretationOf(holder) && { interpretation: interpretationOf(holder) }),
  };
}

// Some feeds send numeric results as strings ("6.1", "<5.0 %"). Parse only the
// unambiguous shape; anything else stays a string.
function quantityFromString(value) {
  if (typeof value !== 'string') return null;
  const match = /^\s*(<=|>=|<|>)?\s*(-?\d+(?:\.\d+)?)\s*(\S+)?\s*$/.exec(value);
  if (!match) return null;
  return { value: Number(match[2]), ...(match[1] && { comparator: match[1] }), ...(match[3] && { unit: match[3] }) };
}

function originalValue(holder) {
  if (holder.valueCodeableConcept) return { code: holder.valueCodeableConcept.coding?.[0]?.code, text: holder.valueCodeableConcept.text };
  if (holder.valueString !== undefined) return { text: holder.valueString };
  return null;
}

function effectiveOf(resource) {
  const value = resource.effectiveDateTime ?? resource.effectiveInstant ?? resource.effectivePeriod?.start ?? resource.issued ?? null;
  return value && dateRange(value) ? value : null;
}

function interpretationOf(holder) {
  const coding = holder?.interpretation?.[0]?.coding?.[0];
  return coding?.code ?? null;
}

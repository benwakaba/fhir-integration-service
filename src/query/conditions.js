// Conditions for a golden patient, mapped to internal concepts through ICD-10-CM
// category roots. Conditions coded only in SNOMED CT stay in the result, marked
// unmapped: SNOMED content is not loaded (UMLS license), and silently dropping
// a patient's problems would be worse than returning them unnormalized.

import { conceptsFor } from '../terminology/concepts.js';
import { normalizeCoding, SNOMED } from '../terminology/systems.js';
import { LINKED_COMPARTMENTS } from './linked.js';

// FHIR: recurrence and relapse are kinds of active.
const ACTIVE = new Set(['active', 'recurrence', 'relapse']);

export async function findConditions(db, masterId, { concepts = null, clinicalStatus = null, since = null, until = null } = {}) {
  const wanted = concepts ? new Set(concepts) : null;
  const { rows } = await db.query(
    `SELECT o.source_id, o.fhir_id, o.resource
     FROM resources o ${LINKED_COMPARTMENTS}
     JOIN sources s ON s.id = o.source_id
     WHERE o.resource_type = 'Condition' AND NOT o.deleted
       AND ($2::timestamptz IS NULL OR COALESCE(o.effective_end, 'infinity') >= $2)
       AND ($3::timestamptz IS NULL OR o.effective_start < $3)
     ORDER BY o.effective_start DESC NULLS LAST, o.last_updated DESC NULLS LAST, s.priority, o.id`,
    [masterId, since, until],
  );

  // One diagnosis reported by two sources (same concept, or same codes, on the
  // same onset day) is listed once, with the other reports in alsoReportedBy.
  const conditions = [];
  const kept = new Map();
  for (const row of rows) {
    const c = conditionFact(row.resource);
    if (wanted && !c.concepts.some((id) => wanted.has(id))) continue;
    if (clinicalStatus && !statusMatches(c.clinicalStatus, clinicalStatus)) continue;
    const fact = { id: `${row.source_id}/Condition/${row.fhir_id}`, source: row.source_id, ...c };
    const what = c.concepts.length ? [...c.concepts].sort().join(',') : c.codes.map((x) => `${x.system}|${x.code}`).sort().join(',');
    const key = what && c.onset ? `${what}|${c.onset.slice(0, 10)}` : null;
    const first = key && kept.get(key);
    if (first && first.source !== fact.source) {
      (first.alsoReportedBy ??= []).push(fact.id);
      continue;
    }
    if (key && !first) kept.set(key, fact);
    conditions.push(fact);
  }
  const unmapped = conditions.filter((c) => !c.concepts.length);
  return {
    count: conditions.length,
    conditions,
    ...(!wanted && {
      unmapped: {
        count: unmapped.length,
        snomedOnly: unmapped.filter((c) => c.codes.length && c.codes.every((x) => x.system === SNOMED)).length,
      },
    }),
  };
}

export function conditionFact(resource) {
  const codes = (resource.code?.coding ?? []).map((coding) => {
    const n = normalizeCoding(coding);
    return { system: n.system, code: n.code, display: coding.display };
  });
  const concepts = [...new Set(codes.flatMap((c) => conceptsFor(c.system, c.code).filter((m) => m.concept.domain === 'condition').map((m) => m.concept.id)))];
  return {
    concepts,
    text: resource.code?.text ?? codes[0]?.display ?? null,
    codes,
    clinicalStatus: resource.clinicalStatus?.coding?.[0]?.code ?? null,
    verificationStatus: resource.verificationStatus?.coding?.[0]?.code ?? null,
    onset: resource.onsetDateTime ?? resource.onsetPeriod?.start ?? null,
    abatement: resource.abatementDateTime ?? resource.abatementPeriod?.end ?? null,
    recorded: resource.recordedDate ?? null,
  };
}

function statusMatches(status, wanted) {
  return wanted === 'active' ? ACTIVE.has(status) : status === wanted;
}

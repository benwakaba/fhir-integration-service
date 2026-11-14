import { notFound } from '../errors.js';

/** The golden patient and the source patients linked to it. */
export async function loadPatient(db, masterId) {
  if (!/^[0-9a-f-]{36}$/i.test(masterId)) throw notFound(`Patient ${masterId} not found`);
  const { rows } = await db.query('SELECT * FROM master_patients WHERE id = $1', [masterId]);
  if (!rows[0]) throw notFound(`Patient ${masterId} not found`);
  const { rows: links } = await db.query(
    `SELECT r.id AS resource_id, r.source_id, r.fhir_id, r.version_id, r.last_updated, r.deleted, pl.method, pl.score, pl.linked_at
     FROM patient_links pl JOIN resources r ON r.id = pl.resource_id
     WHERE pl.master_id = $1 ORDER BY r.source_id, r.fhir_id`,
    [masterId],
  );
  return { master: rows[0], links };
}

// Joins a resource alias `o` to the patient compartments of every source record
// linked to master $1: the query sees all sources' data for one person.
export const LINKED_COMPARTMENTS = `
  JOIN (
    SELECT r.source_id, 'Patient/' || r.fhir_id AS patient_ref
    FROM patient_links pl JOIN resources r ON r.id = pl.resource_id
    WHERE pl.master_id = $1
  ) linked ON linked.source_id = o.source_id AND linked.patient_ref = o.patient_ref`;

export function patientSummary(master, links) {
  const golden = master.golden;
  const name = golden.name?.[0];
  return {
    id: master.id,
    name: name ? [...(name.given ?? []), name.family].filter(Boolean).join(' ') : null,
    birthDate: golden.birthDate ?? null,
    gender: golden.gender ?? null,
    sources: [...new Set(links.filter((l) => !l.deleted).map((l) => l.source_id))],
  };
}

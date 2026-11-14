// The developer API: one patient across all sources, clinical data by internal
// concept, values in one unit. This is the layer an application consumes instead
// of raw, per-source FHIR search.

import { Router } from 'express';
import pool, { withTransaction } from '../db/pool.js';
import { badRequest, notFound, preconditionRequired } from '../errors.js';
import { etag, parseEtag, presentGolden } from '../fhir/present.js';
import { dismissPossibleDuplicates, linkRecord, setOverrides, unlinkRecord } from '../mpi/index.js';
import { everything } from '../mpi/everything.js';
import { findConditions } from '../query/conditions.js';
import { loadPatient, patientSummary } from '../query/linked.js';
import { findObservations } from '../query/observations.js';
import { CONCEPTS, getConcept } from '../terminology/concepts.js';
import { clampInt, parseDate } from './fhir.js';

const router = Router();

router.get('/', async (req, res) => {
  const limit = clampInt(req.query.limit, 50, 1, 500);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const name = req.query.name ? `%${String(req.query.name).toLowerCase()}%` : null;
  const { rows } = await pool.query(
    `SELECT m.id, m.version_id, m.golden, m.needs_review, m.updated_at,
            jsonb_array_length(m.possible_duplicates) AS possible_duplicates,
            array_agg(DISTINCT r.source_id) AS sources, count(pl.resource_id)::int AS records
     FROM master_patients m
     JOIN patient_links pl ON pl.master_id = m.id
     JOIN resources r ON r.id = pl.resource_id
     WHERE ($1::text IS NULL OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(m.golden->'name', '[]')) n WHERE lower(n::text) LIKE $1))
       AND ($2::text IS NULL OR r.source_id = $2)
       AND ($3::boolean IS NULL OR m.needs_review = $3)
     GROUP BY m.id
     HAVING ($4::boolean IS NULL OR (count(DISTINCT r.source_id) > 1) = $4)
     ORDER BY m.updated_at DESC
     LIMIT $5 OFFSET $6`,
    [
      name,
      req.query.source ?? null,
      req.query.needsReview === undefined ? null : req.query.needsReview === 'true',
      req.query.multiSource === undefined ? null : req.query.multiSource === 'true',
      limit,
      offset,
    ],
  );
  res.json({
    patients: rows.map((m) => ({
      ...patientSummary(m, []),
      sources: m.sources,
      records: m.records,
      version: m.version_id,
      needsReview: m.needs_review,
      possibleDuplicates: m.possible_duplicates,
    })),
  });
});

router.get('/:id', async (req, res) => {
  const { master, links } = await loadPatient(pool, req.params.id);
  res.set('ETag', etag(master.version_id)).json({
    patient: patientSummary(master, links),
    version: master.version_id,
    needsReview: master.needs_review,
    golden: presentGolden(master),
    conflicts: master.conflicts,
    possibleDuplicates: master.possible_duplicates,
    overrides: master.overrides,
    links: links.map((l) => ({
      source: l.source_id,
      fhirId: l.fhir_id,
      version: l.version_id,
      method: l.method,
      score: l.score === null ? null : Number(l.score),
      deleted: l.deleted,
    })),
  });
});

router.get('/:id/observations', async (req, res) => {
  const { master, links } = await loadPatient(pool, req.params.id);
  const concepts = conceptsParam(req.query.concept, 'observation');
  const result = await findObservations(pool, master.id, {
    concepts,
    since: req.query.since ? parseDate(req.query.since, 'since') : null,
    until: req.query.until ? parseDate(req.query.until, 'until') : null,
    limit: clampInt(req.query.limit, 100, 1, 1000),
  });
  res.json({
    patient: patientSummary(master, links),
    ...(concepts && { concepts: concepts.map(describeConcept) }),
    ...result,
  });
});

router.get('/:id/conditions', async (req, res) => {
  const { master, links } = await loadPatient(pool, req.params.id);
  const concepts = conceptsParam(req.query.concept, 'condition');
  const result = await findConditions(pool, master.id, {
    concepts,
    clinicalStatus: req.query.status ?? null,
    since: req.query.since ? parseDate(req.query.since, 'since') : null,
    until: req.query.until ? parseDate(req.query.until, 'until') : null,
  });
  res.json({
    patient: patientSummary(master, links),
    ...(concepts && { concepts: concepts.map(describeConcept) }),
    ...result,
  });
});

// Latest normalized value per observation concept and active conditions by
// concept: the "chart header" an application usually wants first.
router.get('/:id/summary', async (req, res) => {
  const { master, links } = await loadPatient(pool, req.params.id);
  const observations = await findObservations(pool, master.id, { limit: Number.MAX_SAFE_INTEGER });
  const latest = {};
  for (const fact of observations.observations) {
    if (fact.value === null || latest[fact.concept]) continue; // newest first
    latest[fact.concept] = { value: fact.value, unit: fact.unit, effective: fact.effective, source: fact.source, id: fact.id };
  }
  const conditions = await findConditions(pool, master.id, { clinicalStatus: 'active' });
  const active = {};
  for (const c of conditions.conditions) for (const id of c.concepts) (active[id] ??= []).push(c.id);
  res.json({
    patient: patientSummary(master, links),
    latestObservations: latest,
    activeConditions: Object.entries(active).map(([concept, ids]) => ({ concept, display: getConcept(concept).display, records: ids })),
    unmappedActiveConditions: conditions.conditions.filter((c) => !c.concepts.length).map((c) => ({ id: c.id, text: c.text })),
  });
});

router.get('/:id/\\$everything', async (req, res) => {
  const bundle = await everything(pool, req.params.id, {
    types: req.query._type ? String(req.query._type).split(',') : null,
    since: req.query._since ? parseDate(req.query._since, '_since') : null,
    count: clampInt(req.query._count, 1000, 1, 5000),
    offset: clampInt(req.query._offset, 0, 0, Number.MAX_SAFE_INTEGER),
  });
  res.type('application/fhir+json').json(bundle);
});

router.get('/:id/history', async (req, res) => {
  await loadPatient(pool, req.params.id);
  const { rows } = await pool.query(
    `SELECT version_id, reason, recorded_at, jsonb_array_length(conflicts) AS conflicts
     FROM master_patient_versions WHERE master_id = $1 ORDER BY version_id DESC`,
    [req.params.id],
  );
  res.json({ versions: rows.map((v) => ({ version: v.version_id, reason: v.reason, at: v.recorded_at, conflicts: v.conflicts })) });
});

// Steward actions. All are version-aware: If-Match must name the current version.

router.put('/:id/overrides', async (req, res) => {
  const expected = requireIfMatch(req);
  const overrides = req.body?.overrides ?? req.body;
  const master = await withTransaction((client) => setOverrides(client, req.params.id, overrides, expected));
  res.set('ETag', etag(master.version_id)).json({ version: master.version_id, golden: presentGolden(master), conflicts: master.conflicts, needsReview: master.needs_review });
});

router.post('/:id/unlink', async (req, res) => {
  const expected = requireIfMatch(req);
  const { source, fhirId } = req.body ?? {};
  if (!source || !fhirId) throw badRequest('Body must name { source, fhirId }');
  const master = await withTransaction((client) => unlinkRecord(client, req.params.id, source, fhirId, expected));
  res.set('ETag', etag(master.version_id)).json({ version: master.version_id, golden: presentGolden(master) });
});

router.post('/:id/link', async (req, res) => {
  const expected = requireIfMatch(req);
  const { source, fhirId } = req.body ?? {};
  if (!source || !fhirId) throw badRequest('Body must name { source, fhirId }');
  const master = await withTransaction((client) => linkRecord(client, req.params.id, source, fhirId, expected));
  res.set('ETag', etag(master.version_id)).json({ version: master.version_id, golden: presentGolden(master), conflicts: master.conflicts });
});

// Not the same person after all. Body { "patient": "<id>" } settles one pair;
// no body dismisses every flag on this patient.
router.post('/:id/dismiss-duplicates', async (req, res) => {
  const expected = requireIfMatch(req);
  const other = req.body?.patient ?? null;
  const master = await withTransaction((client) => dismissPossibleDuplicates(client, req.params.id, expected, other));
  res.set('ETag', etag(master.version_id)).json({ version: master.version_id, needsReview: master.needs_review, possibleDuplicates: master.possible_duplicates });
});

function requireIfMatch(req) {
  const header = req.get('if-match');
  if (header === undefined) throw preconditionRequired('This change requires If-Match with the patient\'s current ETag (GET /patients/:id)');
  const version = parseEtag(header);
  if (version === null) throw badRequest(`If-Match '${header}' is not an ETag like W/"3"`);
  return version;
}

function conceptsParam(value, domain) {
  if (!value) return null;
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    const concept = getConcept(id);
    if (!concept) {
      const known = CONCEPTS.filter((c) => c.domain === domain).map((c) => c.id);
      throw notFound(`Unknown concept '${id}'. Known ${domain} concepts: ${known.join(', ')}`);
    }
    if (concept.domain !== domain) throw badRequest(`'${id}' is a ${concept.domain} concept`);
  }
  return ids;
}

function describeConcept(id) {
  const c = getConcept(id);
  return { id: c.id, display: c.display, ...(c.unit && { unit: c.unit }), codes: c.members.map((m) => (m.match === 'exact' ? m.code : `${m.code}*`)) };
}

export default router;

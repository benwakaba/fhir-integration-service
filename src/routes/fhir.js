// FHIR R4 facade over the store, one base per source: /fhir/{source}/{type}/{id}.
// The virtual source "golden" serves master (golden) Patients.
//
// Versioning semantics:
//  - every read carries ETag: W/"{version}" and Last-Modified
//  - If-None-Match with the current ETag -> 304 Not Modified
//  - updates are version-aware: If-Match is required (428 without it) and must
//    name the current version (412 otherwise); every write mints a new version
//  - deletes are soft: a new version flagged deleted; reads then answer 410 Gone
//    and _history still returns everything

import { Router } from 'express';
import { config } from '../config.js';
import pool, { withTransaction } from '../db/pool.js';
import { badRequest, gone, notFound, preconditionRequired, unprocessable } from '../errors.js';
import { FHIR_JSON, etag, facadeUrl, parseEtag, present, presentGolden } from '../fhir/present.js';
import { ingestOne } from '../ingest/pipeline.js';
import { processBundle } from '../ingest/push.js';
import { getSource, listSources } from '../ingest/sources.js';
import { everything } from '../mpi/everything.js';
import { loadPatient } from '../query/linked.js';
import { getHistory, getResource, getVersion } from '../store/resources.js';
import { structuralIssues } from '../validation/index.js';
import { isKnownResourceType } from '../validation/schema.js';

const router = Router();

function sendResource(res, resource, { versionId, lastModified, status = 200 }) {
  res.status(status).set({ ETag: etag(versionId), 'Last-Modified': lastModified.toUTCString() }).type(FHIR_JSON).json(resource);
}

/** 304 when the client already holds the current version. */
function notModified(req, versionId) {
  const header = req.get('if-none-match');
  return Boolean(header) && header.split(',').some((t) => parseEtag(t) === versionId);
}

function historyBundle(req, entries) {
  return {
    resourceType: 'Bundle',
    type: 'history',
    total: entries.length,
    link: [{ relation: 'self', url: `${req.protocol}://${req.get('host')}${req.originalUrl}` }],
    entry: entries,
  };
}

// --- golden (master) patients -------------------------------------------------

// A merged-away patient is served as itself: inactive, with a replaced-by link.
router.get('/golden/Patient/:id', async (req, res) => {
  const { master } = await loadPatient(pool, req.params.id, { followMerged: false });
  if (notModified(req, master.version_id)) return res.status(304).set('ETag', etag(master.version_id)).end();
  sendResource(res, presentGolden(master), { versionId: master.version_id, lastModified: master.updated_at });
});

router.get('/golden/Patient/:id/\\$everything', async (req, res) => {
  const types = req.query._type ? String(req.query._type).split(',') : null;
  const bundle = await everything(pool, req.params.id, {
    types,
    since: req.query._since ? parseDate(req.query._since, '_since') : null,
    count: clampInt(req.query._count, 1000, 1, 5000),
    offset: clampInt(req.query._offset, 0, 0, Number.MAX_SAFE_INTEGER),
  });
  res.type(FHIR_JSON).json(bundle);
});

router.get('/golden/Patient/:id/_history', async (req, res) => {
  await loadPatient(pool, req.params.id, { followMerged: false });
  const { rows } = await pool.query(
    'SELECT * FROM master_patient_versions WHERE master_id = $1 ORDER BY version_id DESC LIMIT 100',
    [req.params.id],
  );
  res.type(FHIR_JSON).json(
    historyBundle(
      req,
      rows.map((v) => ({
        fullUrl: `${facadeUrl('golden', 'Patient', req.params.id)}/_history/${v.version_id}`,
        resource: presentGolden({ ...v, golden: v.golden, updated_at: v.recorded_at }),
        request: { method: v.version_id === 1 ? 'POST' : 'PUT', url: `Patient/${req.params.id}` },
        response: { status: v.version_id === 1 ? '201 Created' : '200 OK', etag: etag(v.version_id), lastModified: v.recorded_at.toISOString() },
      })),
    ),
  );
});

// --- per-source resources -------------------------------------------------------

router.get('/:source/metadata', async (req, res) => {
  const source = await getSource(pool, req.params.source);
  res.type(FHIR_JSON).json({
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: new Date().toISOString(),
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['json'],
    implementation: { description: `FHIR Integration Service: records from ${source.name}`, url: `${config.publicBaseUrl}/fhir/${source.id}` },
    rest: [
      {
        mode: 'server',
        interaction: [{ code: 'transaction' }, { code: 'batch' }],
        resource: ['Patient', 'Observation', 'Condition', 'Encounter'].map((type) => ({
          type,
          versioning: 'versioned-update',
          readHistory: true,
          updateCreate: source.kind === 'push',
          conditionalRead: 'full-support',
          conditionalDelete: 'not-supported',
          interaction: ['read', 'vread', 'update', 'delete', 'history-instance'].map((code) => ({ code })),
        })),
      },
    ],
  });
});

router.get('/:source/:type/:id', async (req, res) => {
  const { source, row } = await load(req);
  if (row.deleted) throw gone(`${row.resource_type}/${row.fhir_id} was deleted in version ${row.version_id}`);
  if (notModified(req, row.version_id)) return res.status(304).set('ETag', etag(row.version_id)).end();
  sendResource(res, present(row, source), { versionId: row.version_id, lastModified: row.updated_at });
});

router.get('/:source/:type/:id/_history', async (req, res) => {
  const { source, row } = await load(req);
  const versions = await getHistory(pool, source.id, row.resource_type, row.fhir_id);
  res.type(FHIR_JSON).json(
    historyBundle(
      req,
      versions.map((v) => ({
        fullUrl: `${facadeUrl(source.id, v.resource_type, v.fhir_id)}/_history/${v.version_id}`,
        ...(!v.deleted && { resource: present(v, source) }),
        request: { method: v.deleted ? 'DELETE' : v.version_id === 1 ? 'POST' : 'PUT', url: `${v.resource_type}/${v.fhir_id}` },
        response: { status: v.deleted ? '204 No Content' : v.version_id === 1 ? '201 Created' : '200 OK', etag: etag(v.version_id), lastModified: v.updated_at.toISOString() },
      })),
    ),
  );
});

router.get('/:source/:type/:id/_history/:vid', async (req, res) => {
  const source = await getSource(pool, req.params.source);
  const version = await getVersion(pool, source.id, req.params.type, req.params.id, clampInt(req.params.vid, -1, 1, 2 ** 31 - 1));
  if (!version) throw notFound(`${req.params.type}/${req.params.id}/_history/${req.params.vid} not found`);
  if (version.deleted) throw gone(`Version ${version.version_id} is a deletion`);
  sendResource(res, present(version, source), { versionId: version.version_id, lastModified: version.updated_at });
});

// Version-aware update. Single-resource writes are held to a stricter bar than
// ingest: the body must be valid R4 (422 otherwise). Only push sources may create
// resources this way; pull sources own their ids.
router.put('/:source/:type/:id', async (req, res) => {
  const source = await getSource(pool, req.params.source);
  const { type, id } = req.params;
  const body = req.body;
  if (!isKnownResourceType(type)) throw notFound(`Unknown resource type ${type}`);
  if (body?.resourceType !== type) throw badRequest(`Body must be a ${type}`);
  if (body.id !== undefined && body.id !== id) throw badRequest(`Body id '${body.id}' does not match URL id '${id}'`);

  const ifMatch = req.get('if-match');
  const existing = await getResource(pool, source.id, type, id);
  if (existing && ifMatch === undefined) {
    throw preconditionRequired(`Updates require If-Match with the current ETag (${etag(existing.version_id)})`);
  }
  if (!existing && ifMatch === undefined && source.kind !== 'push') {
    throw notFound(`${type}/${id} does not exist; resources from pull source '${source.id}' can only be updated, not created`);
  }
  const expectedVersion = ifMatch === undefined ? undefined : parseEtag(ifMatch);
  if (ifMatch !== undefined && expectedVersion === null) throw badRequest(`If-Match '${ifMatch}' is not an ETag like W/"3"`);

  const resource = { ...body, id };
  const issues = structuralIssues(resource);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) throw unprocessable(`${type}/${id} is not valid FHIR R4`, errors);

  const { outcome, row } = await withTransaction((client) => ingestOne(client, { source, resource, origin: 'api', expectedVersion }));
  sendResource(res, present(row, source), {
    versionId: row.version_id,
    lastModified: row.updated_at,
    status: outcome === 'created' ? 201 : 200,
  });
});

router.delete('/:source/:type/:id', async (req, res) => {
  const { source, row } = await load(req);
  if (row.deleted) return res.status(204).set('ETag', etag(row.version_id)).end(); // idempotent
  const ifMatch = req.get('if-match');
  if (ifMatch === undefined) throw preconditionRequired(`Deletes require If-Match with the current ETag (${etag(row.version_id)})`);
  const expectedVersion = parseEtag(ifMatch);
  if (expectedVersion === null) throw badRequest(`If-Match '${ifMatch}' is not an ETag like W/"3"`);
  const result = await withTransaction((client) =>
    ingestOne(client, { source, resource: row.resource, origin: 'api', expectedVersion, deleted: true, issues: [] }),
  );
  res.status(204).set('ETag', etag(result.row.version_id)).end();
});

// Push: a source delivers a transaction or batch Bundle.
router.post('/:source', async (req, res) => {
  const source = await getSource(pool, req.params.source);
  res.type(FHIR_JSON).json(await processBundle(pool, source, req.body));
});

router.get('/', async (req, res) => {
  const sources = await listSources(pool);
  res.json({ sources: [...sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, base: `/fhir/${s.id}` })), { id: 'golden', name: 'Golden (master) patients', kind: 'derived', base: '/fhir/golden' }] });
});

async function load(req) {
  const source = await getSource(pool, req.params.source);
  const row = await getResource(pool, source.id, req.params.type, req.params.id);
  if (!row) throw notFound(`${req.params.type}/${req.params.id} not found in source '${source.id}'`);
  return { source, row };
}

export function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function parseDate(value, name) {
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) throw badRequest(`${name} must be a date or date-time (e.g. 2024-01-01)`);
  return new Date(t);
}

export default router;

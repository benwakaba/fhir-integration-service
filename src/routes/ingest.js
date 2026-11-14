import { Router } from 'express';
import pool from '../db/pool.js';
import { badRequest, notFound } from '../errors.js';
import { DEFAULT_TYPES, ingestPatients, startRun, syncType } from '../ingest/runner.js';
import { getSource, listSources } from '../ingest/sources.js';
import { createLogger } from '../log.js';
import { clampInt } from './fhir.js';

const router = Router();
const log = createLogger('ingest');

router.get('/sources', async (req, res) => {
  const sources = await listSources(pool);
  res.json({ sources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, baseUrl: s.base_url, priority: s.priority })) });
});

// Start a pull run in the background; poll GET /ingest/runs/:id for progress.
router.post('/ingest/runs', async (req, res) => {
  const { source: sourceId, patients, types, hasCode, sync, since, maxPages } = req.body ?? {};
  const source = await getSource(pool, sourceId ?? '');
  if (source.kind !== 'pull') throw badRequest(`'${source.id}' is a push source; it sends data to POST /fhir/${source.id}`);
  const options = sync
    ? { type: String(sync), since, maxPages: clampInt(maxPages, 20, 1, 500) }
    : {
        patients: clampInt(patients, 20, 1, 1000),
        types: Array.isArray(types) && types.length ? types : DEFAULT_TYPES,
        query: hasCode ? { '_has:Observation:patient:code': hasCode } : {},
      };
  const runId = await startRun(pool, source, sync ? 'sync' : 'patients', options);
  const run = sync ? syncType(source, { ...options, runId, log }) : ingestPatients(source, { ...options, runId, log });
  run.catch((err) => log.error('ingest run failed', { source: source.id, run: runId, error: err.message }));
  res.status(202).location(`/ingest/runs/${runId}`).json({ run: await getRun(runId) });
});

router.get('/ingest/runs', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ingest_runs ORDER BY id DESC LIMIT $1', [clampInt(req.query.limit, 20, 1, 200)]);
  res.json({ runs: rows });
});

router.get('/ingest/runs/:id', async (req, res) => {
  const run = await getRun(clampInt(req.params.id, -1, 1, Number.MAX_SAFE_INTEGER));
  if (!run) throw notFound(`Run ${req.params.id} not found`);
  res.json({ run });
});

async function getRun(id) {
  const { rows } = await pool.query('SELECT * FROM ingest_runs WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export default router;

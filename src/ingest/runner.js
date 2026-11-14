// Pull ingestion from a source FHIR server. Two modes:
//
//   patients  Page through a Patient search (optionally narrowed, e.g. to people
//             with an HbA1c result), then pull each patient's compartment per
//             resource type.
//   sync      Page through one resource type changed since the stored high-water
//             mark (_lastUpdated), for incremental refresh.
//
// Every page is stored in its own transaction, so an interrupted run keeps what it
// finished, and re-running is idempotent (unchanged resources mint no versions).

import { config } from '../config.js';
import pool, { withTransaction } from '../db/pool.js';
import { createFhirClient } from '../fhir/client.js';
import { entriesOf, paginate } from '../fhir/paginate.js';
import { createLogger } from '../log.js';
import { ingestBatch } from './pipeline.js';

export const DEFAULT_TYPES = ['Observation', 'Condition'];

export function clientFor(source, options = {}) {
  if (!source.base_url) throw new Error(`Source '${source.id}' is push-only; it cannot be pulled from`);
  return createFhirClient({ baseUrl: source.base_url, timeoutMs: config.requestTimeoutMs, ...options });
}

export async function startRun(db, source, mode, params) {
  const { rows } = await db.query('INSERT INTO ingest_runs (source_id, mode, params) VALUES ($1, $2, $3) RETURNING id', [source.id, mode, params]);
  return rows[0].id;
}

async function recordPage(db, runId, counts) {
  await db.query(
    `UPDATE ingest_runs SET pages = pages + 1, created = created + $2, updated = updated + $3,
       unchanged = unchanged + $4, with_errors = with_errors + $5 WHERE id = $1`,
    [runId, counts.created, counts.updated, counts.unchanged, counts.withErrors],
  );
}

async function finishRun(db, runId, error) {
  const { rows } = await db.query(
    `UPDATE ingest_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1 RETURNING *`,
    [runId, error ? 'failed' : 'completed', error?.message ?? null],
  );
  return rows[0];
}

async function storePage(db, source, runId, resources) {
  const counts = await withTransaction((client) => ingestBatch(client, { source, resources, origin: 'ingest', runId }));
  await recordPage(db, runId, counts);
  return counts;
}

/**
 * @param patients how many patients to ingest
 * @param query extra Patient search parameters, e.g. { '_has:Observation:patient:code': 'http://loinc.org|4548-4' }
 */
export async function ingestPatients(source, { patients = 20, types = DEFAULT_TYPES, query = {}, concurrency = 4, maxPagesPerType = 50, client, runId: existingRun, log = createLogger('ingest'), db = pool } = {}) {
  const fhir = client ?? clientFor(source, { log });
  const runId = existingRun ?? (await startRun(db, source, 'patients', { patients, types, query }));
  try {
    const ids = [];
    const search = fhir.searchUrl('Patient', { ...query, _count: Math.min(patients, 100) });
    for await (const { bundle, page } of paginate(fhir, search)) {
      const found = entriesOf(bundle).resources.filter((r) => r.resourceType === 'Patient').slice(0, patients - ids.length);
      await storePage(db, source, runId, found);
      ids.push(...found.map((p) => p.id));
      log.info('patients page stored', { source: source.id, page, total: ids.length });
      if (ids.length >= patients) break;
    }

    await forEachLimit(ids, concurrency, async (id) => {
      for (const type of types) {
        const url = fhir.searchUrl(type, { patient: id, _count: 200 });
        for await (const { bundle } of paginate(fhir, url, { maxPages: maxPagesPerType })) {
          const { resources, outcomes } = entriesOf(bundle);
          for (const o of outcomes) log.warn('source attached an OperationOutcome', { source: source.id, type, diagnostics: o.issue?.[0]?.diagnostics });
          if (resources.length) await storePage(db, source, runId, resources);
        }
      }
      log.debug('patient compartment stored', { source: source.id, patient: id });
    });
    return await finishRun(db, runId);
  } catch (err) {
    await finishRun(db, runId, err);
    throw err;
  }
}

/** Incremental sync of one resource type from the stored _lastUpdated cursor (or `since`). */
export async function syncType(source, { type, since, maxPages = 20, pageSize = 100, client, runId: existingRun, log = createLogger('sync'), db = pool } = {}) {
  const fhir = client ?? clientFor(source, { log });
  const { rows } = await db.query('SELECT last_updated FROM sync_cursors WHERE source_id = $1 AND resource_type = $2', [source.id, type]);
  const from = since ? new Date(since) : (rows[0]?.last_updated ?? null);
  const runId = existingRun ?? (await startRun(db, source, 'sync', { type, from: from?.toISOString() ?? null, maxPages }));
  // ge, not gt: a crash mid-page must not skip resources sharing the cursor's timestamp.
  // Re-reading a few unchanged resources is cheap; they mint no versions.
  const params = { _sort: '_lastUpdated', _count: pageSize, ...(from && { _lastUpdated: `ge${from.toISOString()}` }) };
  try {
    for await (const { bundle } of paginate(fhir, fhir.searchUrl(type, params), { maxPages })) {
      const { resources } = entriesOf(bundle);
      if (!resources.length) continue;
      await storePage(db, source, runId, resources);
      const newest = resources.map((r) => Date.parse(r.meta?.lastUpdated ?? '')).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0);
      if (newest) {
        await db.query(
          `INSERT INTO sync_cursors (source_id, resource_type, last_updated) VALUES ($1, $2, $3)
           ON CONFLICT (source_id, resource_type) DO UPDATE
             SET last_updated = GREATEST(sync_cursors.last_updated, EXCLUDED.last_updated), updated_at = now()`,
          [source.id, type, new Date(newest)],
        );
      }
    }
    return await finishRun(db, runId);
  } catch (err) {
    await finishRun(db, runId, err);
    throw err;
  }
}

async function forEachLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

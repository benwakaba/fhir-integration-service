// Push path: a source sends a Bundle to POST /fhir/{source}, the way an EHR
// feeds data over a FHIR interface. transaction = all-or-nothing in one database
// transaction; batch = each entry succeeds or fails on its own.
//
//  - POST entries: a urn:uuid fullUrl becomes the resource id (so re-sending the
//    same bundle updates instead of duplicating), and references to it are rewritten.
//  - PUT/DELETE entries honor request.ifMatch (412 on a stale version).
//  - Like pulled data, pushed data is stored even when it does not validate;
//    each entry's response carries the issues found.

import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { etag, operationOutcome, parseEtag } from '../fhir/present.js';
import { getResource } from '../store/resources.js';
import { validateResources } from '../validation/index.js';
import { ingestOne } from './pipeline.js';

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 404: 'Not Found', 409: 'Conflict',
  410: 'Gone', 412: 'Precondition Failed', 422: 'Unprocessable Entity', 428: 'Precondition Required', 500: 'Internal Server Error',
};

export async function processBundle(db, source, bundle) {
  if (bundle?.resourceType !== 'Bundle') throw badRequest('Expected a Bundle');
  if (bundle.type !== 'transaction' && bundle.type !== 'batch') {
    throw badRequest(`POST /fhir/${source.id} takes a transaction or batch Bundle, not '${bundle.type}'`);
  }
  const steps = plan(bundle.entry ?? []);
  const { rows } = await db.query(`INSERT INTO ingest_runs (source_id, mode, params) VALUES ($1, 'push', $2) RETURNING id`, [
    source.id,
    { bundleType: bundle.type, entries: steps.length },
  ]);
  const runId = rows[0].id;
  const tally = { created: 0, updated: 0, unchanged: 0, with_errors: 0 };

  let responses;
  try {
    if (bundle.type === 'transaction') {
      const failed = steps.find((s) => s.error);
      if (failed) throw atEntry(failed.index, failed.error);
      responses = await withTransaction(async (client) => {
        const issues = await validateAll(client, steps);
        const out = [];
        for (const step of steps) {
          try {
            out.push(await apply(client, source, step, runId, issues.get(step), tally));
          } catch (err) {
            throw atEntry(step.index, err);
          }
        }
        return out;
      });
    } else {
      responses = [];
      for (const step of steps) {
        try {
          if (step.error) throw step.error;
          responses.push(await withTransaction(async (client) => {
            const issues = await validateAll(client, [step]);
            return apply(client, source, step, runId, issues.get(step), tally);
          }));
        } catch (err) {
          responses.push(failure(err));
        }
      }
    }
    await finishRun(db, runId, tally);
  } catch (err) {
    await finishRun(db, runId, { created: 0, updated: 0, unchanged: 0, with_errors: 0 }, err);
    throw err;
  }
  return { resourceType: 'Bundle', type: `${bundle.type}-response`, entry: responses };
}

function plan(entries) {
  const ids = new Map(); // urn:uuid fullUrl -> 'Type/id'
  const steps = entries.map((entry, index) => {
    const method = entry?.request?.method;
    const url = (entry?.request?.url ?? '').split('?')[0];
    if (!['POST', 'PUT', 'DELETE'].includes(method)) return { index, error: badRequest(`request.method '${method}' is not supported here`) };
    if (method === 'POST') {
      const resource = entry.resource;
      if (!resource?.resourceType) return { index, error: badRequest('POST entry has no resource') };
      const id = entry.fullUrl?.startsWith('urn:uuid:') ? entry.fullUrl.slice('urn:uuid:'.length) : (resource.id ?? randomUUID());
      if (entry.fullUrl) ids.set(entry.fullUrl, `${resource.resourceType}/${id}`);
      return { index, method, type: resource.resourceType, id, resource };
    }
    const [type, id, extra] = url.split('/');
    if (!type || !id || extra) return { index, error: badRequest(`request.url '${entry.request.url}' must be [type]/[id]`) };
    if (method === 'PUT' && entry.resource?.id && entry.resource.id !== id) return { index, error: badRequest(`resource.id '${entry.resource.id}' does not match request.url '${url}'`) };
    if (method === 'PUT' && entry.resource?.resourceType !== type) return { index, error: badRequest(`PUT ${url} needs a ${type} resource`) };
    return { index, method, type, id, resource: entry.resource, ifMatch: entry.request.ifMatch };
  });
  for (const step of steps) {
    if (!step.resource) continue;
    step.resource = rewriteUuidRefs(structuredClone(step.resource), ids);
    step.resource.id = step.id;
  }
  return steps;
}

function rewriteUuidRefs(node, ids) {
  if (Array.isArray(node)) return node.map((n) => rewriteUuidRefs(n, ids));
  if (!node || typeof node !== 'object') return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'reference' && typeof value === 'string' && ids.has(value)) node[key] = ids.get(value);
    else node[key] = rewriteUuidRefs(value, ids);
  }
  return node;
}

async function validateAll(client, steps) {
  const writes = steps.filter((s) => s.method !== 'DELETE' && s.resource);
  const found = await validateResources(client, writes.map((s) => s.resource));
  return new Map(writes.map((s, i) => [s, found[i]]));
}

async function apply(client, source, step, runId, issues, tally) {
  let expectedVersion;
  if (step.ifMatch !== undefined) {
    expectedVersion = parseEtag(step.ifMatch);
    if (expectedVersion === null) throw badRequest(`request.ifMatch '${step.ifMatch}' is not an ETag like W/"3"`);
  }
  if (step.method === 'DELETE') {
    const current = await getResource(client, source.id, step.type, step.id);
    if (!current || current.deleted) throw notFound(`${step.type}/${step.id} not found`);
    const { row } = await ingestOne(client, { source, resource: current.resource, origin: 'push', runId, expectedVersion, deleted: true, issues: [] });
    tally.updated++;
    return { response: { status: '204 No Content', etag: etag(row.version_id) } };
  }
  const { outcome, row } = await ingestOne(client, { source, resource: step.resource, origin: 'push', runId, expectedVersion, issues });
  tally[outcome]++;
  if (outcome !== 'unchanged' && issues.some((i) => i.severity === 'error')) tally.with_errors++;
  return {
    response: {
      status: outcome === 'created' ? '201 Created' : '200 OK',
      location: `${step.type}/${step.id}/_history/${row.version_id}`,
      etag: etag(row.version_id),
      lastModified: row.updated_at.toISOString(),
      ...(issues.length && { outcome: operationOutcome(null, null, null, issues) }),
    },
  };
}

function atEntry(index, err) {
  const status = err.status ?? 500;
  return new HttpError(status, `Bundle.entry[${index}]: ${err.message}`, { code: err.code ?? 'exception' });
}

function failure(err) {
  const status = err.status ?? 500;
  return {
    response: {
      status: `${status} ${STATUS_TEXT[status] ?? ''}`.trim(),
      outcome: operationOutcome('error', err.code ?? 'exception', err.message),
    },
  };
}

async function finishRun(db, runId, tally, error) {
  await db.query(
    `UPDATE ingest_runs SET status = $2, created = $3, updated = $4, unchanged = $5, with_errors = $6, pages = 1,
       error = $7, finished_at = now() WHERE id = $1`,
    [runId, error ? 'failed' : 'completed', tally.created, tally.updated, tally.unchanged, tally.with_errors, error?.message ?? null],
  );
}

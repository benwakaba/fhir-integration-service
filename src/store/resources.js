// Versioned resource store. Every change mints a new local version and appends
// the full resource to resource_versions; nothing is ever overwritten in place.
// The local version is what this service exposes as meta.versionId and ETag W/"n".
// The source's own meta.versionId/lastUpdated are kept alongside for provenance.
//
// Content-identical saves (a source bumping its version without changing
// anything) do not mint a version; see fhir/canonical.js.

import { contentHash } from '../fhir/canonical.js';
import { clinicalTime } from '../fhir/dates.js';
import { patientRefOf } from '../fhir/references.js';
import { preconditionFailed } from '../errors.js';

/**
 * Save one resource inside the caller's transaction.
 *
 * @param origin 'ingest' (we pulled it), 'push' (the source sent it), 'api' (edited through this service)
 * @param expectedVersion If-Match semantics: the current local version must equal this.
 *   A resource that does not exist cannot match, so it is never created when this is set.
 * @returns {{ outcome: 'created' | 'updated' | 'unchanged', row }}
 */
export async function saveResource(client, { source, resource, origin, runId = null, expectedVersion, deleted = false }) {
  const body = origin === 'api' ? withoutServerMeta(resource) : resource;
  const hash = contentHash(body);
  const time = clinicalTime(body);
  const patientRef = patientRefOf(body, source.base_url);
  const key = [source.id, body.resourceType, body.id];

  if (expectedVersion === undefined) {
    const { rows } = await client.query(
      `INSERT INTO resources (source_id, resource_type, fhir_id, version_id, source_version_id, last_updated,
         content_hash, deleted, patient_ref, effective_start, effective_end, resource)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (source_id, resource_type, fhir_id) DO NOTHING
       RETURNING *`,
      [...key, sourceVersionOf(body, origin), lastUpdatedOf(body, origin), hash, deleted, patientRef, time?.start ?? null, time?.end ?? null, body],
    );
    if (rows[0]) {
      await appendVersion(client, rows[0], origin, runId);
      return { outcome: 'created', row: rows[0] };
    }
  }

  const { rows: locked } = await client.query(
    'SELECT * FROM resources WHERE source_id = $1 AND resource_type = $2 AND fhir_id = $3 FOR UPDATE',
    key,
  );
  const current = locked[0];
  if (!current) throw preconditionFailed(`${body.resourceType}/${body.id} does not exist, so If-Match cannot match`);
  if (expectedVersion !== undefined && current.version_id !== expectedVersion) {
    throw preconditionFailed(
      `Version conflict on ${body.resourceType}/${body.id}: If-Match was W/"${expectedVersion}" but the current version is W/"${current.version_id}"`,
    );
  }

  // Edits made through this API keep pointing at the source version they were derived from.
  const sourceVersionId = origin === 'api' ? current.source_version_id : sourceVersionOf(body, origin);
  const lastUpdated = lastUpdatedOf(body, origin);

  if (current.content_hash === hash && current.deleted === deleted) {
    const dated = origin === 'ingest' || Boolean(body.meta?.lastUpdated);
    if (dated && (sourceVersionId !== current.source_version_id || lastUpdated?.getTime() !== current.last_updated?.getTime())) {
      await client.query('UPDATE resources SET source_version_id = $2, last_updated = $3 WHERE id = $1', [current.id, sourceVersionId, lastUpdated]);
    }
    return { outcome: 'unchanged', row: current };
  }

  const { rows } = await client.query(
    `UPDATE resources
     SET version_id = version_id + 1, source_version_id = $2, last_updated = $3, content_hash = $4, deleted = $5,
         patient_ref = $6, effective_start = $7, effective_end = $8, resource = $9, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [current.id, sourceVersionId, lastUpdated, hash, deleted, patientRef, time?.start ?? null, time?.end ?? null, body],
  );
  await appendVersion(client, rows[0], origin, runId);
  return { outcome: 'updated', row: rows[0] };
}

async function appendVersion(client, row, origin, runId) {
  await client.query(
    `INSERT INTO resource_versions (resource_id, version_id, source_version_id, last_updated, content_hash, deleted,
       change_origin, ingest_run_id, resource, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [row.id, row.version_id, row.source_version_id, row.last_updated, row.content_hash, row.deleted, origin, runId, row.resource, row.updated_at],
  );
}

export async function getResource(db, sourceId, type, id) {
  const { rows } = await db.query('SELECT * FROM resources WHERE source_id = $1 AND resource_type = $2 AND fhir_id = $3', [sourceId, type, id]);
  return rows[0] ?? null;
}

/** One historical version, shaped like a resources row (vread). */
export async function getVersion(db, sourceId, type, id, versionId) {
  const { rows } = await db.query(
    `SELECT r.id, r.source_id, r.resource_type, r.fhir_id, v.version_id, v.source_version_id, v.last_updated,
            v.content_hash, v.deleted, v.change_origin, v.resource, v.recorded_at AS updated_at
     FROM resources r JOIN resource_versions v ON v.resource_id = r.id
     WHERE r.source_id = $1 AND r.resource_type = $2 AND r.fhir_id = $3 AND v.version_id = $4`,
    [sourceId, type, id, versionId],
  );
  return rows[0] ?? null;
}

/** All versions, newest first (history). */
export async function getHistory(db, sourceId, type, id, { limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT r.id, r.source_id, r.resource_type, r.fhir_id, v.version_id, v.source_version_id, v.last_updated,
            v.content_hash, v.deleted, v.change_origin, v.resource, v.recorded_at AS updated_at
     FROM resources r JOIN resource_versions v ON v.resource_id = r.id
     WHERE r.source_id = $1 AND r.resource_type = $2 AND r.fhir_id = $3
     ORDER BY v.version_id DESC
     LIMIT $4`,
    [sourceId, type, id, limit],
  );
  return rows;
}

// meta.versionId/lastUpdated/source are managed by this server; what a client sends
// in them (usually the version it read from us) is not content.
function withoutServerMeta(resource) {
  if (!resource.meta) return resource;
  const { versionId, lastUpdated, source, ...meta } = resource.meta;
  const copy = { ...resource };
  if (Object.keys(meta).length) copy.meta = meta;
  else delete copy.meta;
  return copy;
}

function sourceVersionOf(resource, origin) {
  return origin === 'api' ? null : (resource.meta?.versionId ?? null);
}

// The time a source last changed a record: its meta.lastUpdated when it sends one.
// A push without one is dated by its arrival, which is the best evidence we have.
function lastUpdatedOf(resource, origin) {
  if (origin === 'api') return new Date();
  const t = Date.parse(resource.meta?.lastUpdated ?? '');
  if (!Number.isNaN(t)) return new Date(t);
  return origin === 'push' ? new Date() : null;
}

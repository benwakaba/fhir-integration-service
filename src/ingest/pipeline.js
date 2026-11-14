// The write path every source goes through, pulled or pushed: store the version,
// record what validation found in it, and keep the patient index current.
// Ingest is permissive on purpose: whatever a source sends is stored with its
// issues, because measuring non-conformance is the point. (Edits made through
// this service's own API are held to a stricter bar; see routes/fhir.js.)

import { onPatientChanged } from '../mpi/index.js';
import { saveResource } from '../store/resources.js';
import { validateResources } from '../validation/index.js';
import { hasErrors } from '../validation/issues.js';

/** Store one resource version and everything derived from it. */
export async function ingestOne(client, { source, resource, origin, runId = null, expectedVersion, deleted = false, issues }) {
  const found = issues ?? (await validateResources(client, [resource]))[0];
  const { outcome, row } = await saveResource(client, { source, resource, origin, runId, expectedVersion, deleted });
  if (outcome !== 'unchanged') {
    await recordIssues(client, row, found);
    if (row.resource_type === 'Patient') await onPatientChanged(client, row);
  }
  return { outcome, row, issues: found };
}

/** A page of resources from one source, validated with one terminology query. */
export async function ingestBatch(client, { source, resources, origin, runId = null }) {
  const counts = { created: 0, updated: 0, unchanged: 0, withErrors: 0, skipped: 0 };
  // Without a type and id a resource has no identity to version; count it, do not store it.
  const storable = resources.filter((r) => typeof r?.resourceType === 'string' && typeof r.id === 'string' && r.id);
  counts.skipped = resources.length - storable.length;
  const issues = await validateResources(client, storable);
  for (let i = 0; i < storable.length; i++) {
    const { outcome } = await ingestOne(client, { source, resource: storable[i], origin, runId, issues: issues[i] });
    counts[outcome]++;
    if (outcome !== 'unchanged' && hasErrors(issues[i])) counts.withErrors++;
  }
  return counts;
}

export async function recordIssues(client, row, issues) {
  await client.query('DELETE FROM validation_issues WHERE resource_id = $1 AND version_id = $2', [row.id, row.version_id]);
  if (!issues?.length) return;
  const columns = ['severity', 'category', 'rule', 'element', 'path', 'message'];
  await client.query(
    `INSERT INTO validation_issues (resource_id, version_id, ${columns.join(', ')})
     SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])`,
    [row.id, row.version_id, ...columns.map((c) => issues.map((i) => i[c]))],
  );
}

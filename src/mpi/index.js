// Master patient index: links every source Patient to exactly one master
// (golden) patient and keeps the golden record current as sources change.
// All functions run inside the caller's transaction.

import { config } from '../config.js';
import { badRequest, conflict, notFound, preconditionFailed, unprocessable } from '../errors.js';
import { canonicalJson } from '../fhir/canonical.js';
import { resolveMerged } from '../query/linked.js';
import { structuralIssues } from '../validation/index.js';
import { hasErrors } from '../validation/issues.js';
import {
  CANDIDATE_THRESHOLD,
  contradicts,
  demographicScore,
  differingIdentifiers,
  identifierPatterns,
  sharedIdentifiers,
  trustedIdentifiers,
} from './match.js';
import { loadGroupOf, parseGroupEtag, planConfirm } from './groups.js';
import { survive } from './survivorship.js';

// Link decisions are serialized: two sources delivering the same new person at
// the same moment must not each create a master.
const MPI_LOCK = 72_401;

const linkUrl = (record) => `${config.publicBaseUrl}/fhir/${record.sourceId}/Patient/${record.fhirId}`;
const goldenUrl = (id) => `${config.publicBaseUrl}/fhir/golden/Patient/${id}`;

/** Called after a source Patient version is stored. */
export async function onPatientChanged(client, row) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [MPI_LOCK]);
  const { rows } = await client.query('SELECT master_id FROM patient_links WHERE resource_id = $1', [row.id]);
  if (rows[0]) {
    return recomputeGolden(client, rows[0].master_id, `${row.source_id}/Patient/${row.fhir_id} v${row.version_id}`);
  }
  if (row.deleted) return null;

  const { match, possibleDuplicates } = await findMatch(client, row);
  const masterId = match?.masterId ?? (await createMaster(client));
  await client.query(
    'INSERT INTO patient_links (resource_id, master_id, method, score, matched_on) VALUES ($1, $2, $3, $4, $5)',
    [row.id, masterId, match?.method ?? 'new', match?.score ?? null, match ? JSON.stringify(match.matchedOn) : null],
  );
  for (const dup of possibleDuplicates) {
    const note = { reason: dup.reason, identifiers: dup.identifiers, score: dup.score, record: `${row.source_id}/Patient/${row.fhir_id}` };
    await addPossibleDuplicate(client, masterId, { masterId: dup.masterId, ...note });
    const added = await addPossibleDuplicate(client, dup.masterId, { masterId, ...note });
    await recomputeGolden(client, dup.masterId, `possible duplicate of ${masterId} (${dup.reason})`, { always: added });
  }
  const reason = match
    ? `linked ${row.source_id}/Patient/${row.fhir_id} (${match.method})`
    : `created from ${row.source_id}/Patient/${row.fhir_id}`;
  return recomputeGolden(client, masterId, reason);
}

/** Flag `entry.masterId` on a master; false if that pair was already flagged. */
async function addPossibleDuplicate(client, masterId, entry) {
  const { rowCount } = await client.query(
    `UPDATE master_patients
     SET possible_duplicates = possible_duplicates || $2::jsonb
     WHERE id = $1 AND NOT possible_duplicates @> $3::jsonb`,
    [masterId, JSON.stringify([entry]), JSON.stringify([{ masterId: entry.masterId }])],
  );
  return rowCount > 0;
}

/**
 * { match, possibleDuplicates }: the master to link to (or null for a new one), and
 * masters a steward should look at: ones that share a trusted identifier but
 * contradict this record on identity, and ones that only resemble it.
 */
async function findMatch(client, row) {
  const patient = row.resource;
  const possibleDuplicates = [];

  // 1. Deterministic: a trusted identifier already on file, not contradicted by
  //    birthDate or gender. Merging two people is worse than keeping a duplicate.
  const identifiers = trustedIdentifiers(patient);
  if (identifiers.length) {
    const patterns = identifiers.flatMap(identifierPatterns).map((p) => JSON.stringify(p));
    // Explicit ORs (not @> ANY(...)) so the planner can BitmapOr the GIN index.
    const containment = patterns.map((_, i) => `r.resource @> $${i + 2}::jsonb`).join(' OR ');
    const { rows } = await client.query(
      `SELECT pl.master_id, min(m.created_at) AS created_at, (array_agg(m.golden))[1] AS golden
       FROM resources r
       JOIN patient_links pl ON pl.resource_id = r.id
       JOIN master_patients m ON m.id = pl.master_id
       WHERE r.resource_type = 'Patient' AND NOT r.deleted AND r.id <> $1 AND (${containment})
       GROUP BY pl.master_id
       ORDER BY 2`,
      [row.id, ...patterns],
    );
    const systems = identifiers.map((i) => i.system);
    for (const candidate of rows) {
      const reason = contradicts(patient, candidate.golden);
      if (reason) {
        possibleDuplicates.push({ masterId: candidate.master_id, reason: `shares ${systems.join(', ')} but ${reason}`, identifiers: systems });
        continue;
      }
      const others = rows.filter((r) => r !== candidate).map((r) => r.master_id);
      return { match: { masterId: candidate.master_id, method: 'identifier', score: 1, matchedOn: { identifiers: systems, otherMasters: others } }, possibleDuplicates };
    }
  }

  // 2. Records that resemble this one: same birthDate (the blocking key, found by
  //    GIN containment), then name scored in JS. Resemblance alone never links.
  //    Name and birthDate agreeing is evidence, not identity: two people can share
  //    both, and probabilistic matching with no human in the loop is how two
  //    patients end up in one chart.
  if (!patient.birthDate) return { match: null, possibleDuplicates };
  const { rows: candidates } = await client.query(
    `SELECT r.resource, pl.master_id
     FROM resources r JOIN patient_links pl ON pl.resource_id = r.id
     WHERE r.resource_type = 'Patient' AND NOT r.deleted AND r.id <> $1 AND r.resource @> $2::jsonb
     ORDER BY r.id`,
    [row.id, JSON.stringify({ birthDate: patient.birthDate })],
  );
  const similar = new Map(); // master -> its most convincing record
  const renamed = new Map(); // master -> identifier systems shared by a record whose name differs
  for (const c of candidates) {
    if (possibleDuplicates.some((d) => d.masterId === c.master_id)) continue;
    const score = demographicScore(patient, c.resource);
    const shared = sharedIdentifiers(patient, c.resource);
    if (score < CANDIDATE_THRESHOLD) {
      if (shared.length) renamed.set(c.master_id, shared);
      continue;
    }
    const best = similar.get(c.master_id);
    if (!best || shared.length > best.shared.length || (shared.length === best.shared.length && score > best.score)) {
      similar.set(c.master_id, { score, shared, resource: c.resource });
    }
  }

  //    2a. A similar record that also carries the same identifier value in the
  //        same namespace (an MRN, a member id) is this record seen twice: link.
  let match = null;
  const [corroborated] = [...similar].filter(([, s]) => s.shared.length).sort((x, y) => y[1].score - x[1].score);
  if (corroborated) {
    const [masterId, { score, shared }] = corroborated;
    match = { masterId, method: 'identifier+demographics', score, matchedOn: { identifiers: shared, birthDate: patient.birthDate } };
    similar.delete(masterId);
  }

  //    2b. Everything else that resembles it is a review candidate on both golden
  //        records; only a steward can merge them.
  for (const [masterId, { score, resource }] of similar) {
    const differing = differingIdentifiers(patient, resource);
    possibleDuplicates.push({
      masterId,
      score,
      reason: differing.length
        ? `name and birthDate agree (score ${score}) but ${differing.join(', ')} differs`
        : `name and birthDate agree (score ${score}) with no identifier in common`,
    });
  }

  //    2c. The same identifier and birthDate under a different name is what a name
  //        change looks like (or a reused identifier): also a question for a steward.
  for (const [masterId, shared] of renamed) {
    if (masterId === match?.masterId || similar.has(masterId)) continue;
    possibleDuplicates.push({ masterId, identifiers: shared, reason: `shares ${shared.join(', ')} and birthDate but the name differs` });
  }
  return { match, possibleDuplicates };
}

async function createMaster(client) {
  // Version 0 is a placeholder; the first recompute makes it version 1.
  const { rows } = await client.query(`INSERT INTO master_patients (version_id, golden) VALUES (0, '{}') RETURNING id`);
  return rows[0].id;
}

/**
 * Re-run survivorship; mints a new master version only if the result changed, or
 * when `always` is set because the review flags did (they are part of what a
 * steward saw, so they must move the ETag too).
 */
export async function recomputeGolden(client, masterId, reason, { always = false } = {}) {
  const { rows: masters } = await client.query('SELECT * FROM master_patients WHERE id = $1 FOR UPDATE', [masterId]);
  const master = masters[0];
  if (!master) throw notFound(`Patient ${masterId} not found`);
  const { rows: records } = await client.query(
    `SELECT r.source_id, r.fhir_id, r.last_updated, r.resource, s.priority
     FROM patient_links pl
     JOIN resources r ON r.id = pl.resource_id
     JOIN sources s ON s.id = r.source_id
     WHERE pl.master_id = $1 AND NOT r.deleted`,
    [masterId],
  );
  // A patient whose every record moved elsewhere is a tombstone: inactive, and
  // pointing at the patient that replaced it (FHIR's replaced-by link).
  const survived =
    !records.length && master.merged_into
      ? {
          golden: { resourceType: 'Patient', id: masterId, active: false, link: [{ other: { reference: goldenUrl(master.merged_into) }, type: 'replaced-by' }] },
          conflicts: [],
          needsReview: false,
        }
      : survive(
          records.map((r) => ({ sourceId: r.source_id, fhirId: r.fhir_id, priority: r.priority, lastUpdated: r.last_updated, resource: r.resource })),
          master.overrides,
          { masterId, linkUrl },
        );
  const { golden, conflicts } = survived;
  const needsReview = survived.needsReview || master.possible_duplicates.length > 0;
  if (
    !always &&
    master.version_id > 0 &&
    canonicalJson(golden) === canonicalJson(master.golden) &&
    canonicalJson(conflicts) === canonicalJson(master.conflicts) &&
    needsReview === master.needs_review
  ) {
    return master;
  }
  const { rows } = await client.query(
    `UPDATE master_patients
     SET version_id = version_id + 1, golden = $2, conflicts = $3, needs_review = $4, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [masterId, JSON.stringify(golden), JSON.stringify(conflicts), needsReview],
  );
  const updated = rows[0];
  await client.query(
    `INSERT INTO master_patient_versions (master_id, version_id, golden, overrides, conflicts, reason, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [masterId, updated.version_id, JSON.stringify(golden), JSON.stringify(updated.overrides), JSON.stringify(conflicts), reason, updated.updated_at],
  );
  return updated;
}

async function lockMaster(client, masterId, expectedVersion) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [MPI_LOCK]);
  const { rows } = await client.query('SELECT * FROM master_patients WHERE id = $1 FOR UPDATE', [masterId]);
  if (!rows[0]) throw notFound(`Patient ${masterId} not found`);
  if (rows[0].merged_into) throw conflict(`Patient ${masterId} was merged into ${await resolveMerged(client, masterId)}; act on that patient instead`);
  if (rows[0].version_id !== expectedVersion) {
    throw preconditionFailed(`Version conflict: If-Match was W/"${expectedVersion}" but patient ${masterId} is at W/"${rows[0].version_id}"`);
  }
  return rows[0];
}

/**
 * Replace the steward overrides ({ element: value | null }) and recompute. The
 * resulting golden record must still be valid R4, or nothing is saved.
 */
export async function setOverrides(client, masterId, overrides, expectedVersion) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw badRequest('overrides must be an object of Patient elements');
  for (const key of ['resourceType', 'id', 'meta', 'link']) {
    if (key in overrides) throw badRequest(`'${key}' is managed by the service and cannot be overridden`);
  }
  const master = await lockMaster(client, masterId, expectedVersion);
  const candidate = { ...master.golden, ...overrides };
  for (const [k, v] of Object.entries(overrides)) if (v === null) delete candidate[k];
  const issues = structuralIssues(candidate).filter((i) => i.severity === 'error');
  if (hasErrors(issues)) throw unprocessable('Overrides would make the golden Patient invalid R4', issues);
  await client.query('UPDATE master_patients SET overrides = $2 WHERE id = $1', [masterId, JSON.stringify(overrides)]);
  return recomputeGolden(client, masterId, 'steward overrides updated');
}

/** Move a source Patient out of this master into a new one of its own (a wrong link). */
export async function unlinkRecord(client, masterId, sourceId, fhirId, expectedVersion) {
  await lockMaster(client, masterId, expectedVersion);
  const link = await findLink(client, sourceId, fhirId);
  if (link.master_id !== masterId) throw badRequest(`${sourceId}/Patient/${fhirId} is not linked to patient ${masterId}`);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM patient_links WHERE master_id = $1', [masterId]);
  if (rows[0].n < 2) throw badRequest('Cannot unlink the only source record of a patient');
  const newMaster = await createMaster(client);
  await client.query(`UPDATE patient_links SET master_id = $2, method = 'manual', score = NULL, linked_at = now() WHERE resource_id = $1`, [link.resource_id, newMaster]);
  await recomputeGolden(client, newMaster, `unlinked ${sourceId}/Patient/${fhirId} from ${masterId}`);
  return recomputeGolden(client, masterId, `unlinked ${sourceId}/Patient/${fhirId}`);
}

/**
 * Link a source Patient to this master, moving it from wherever it was. This is
 * how a steward confirms a possible duplicate: the only way two records without
 * a shared trusted identifier ever become one person.
 */
export async function linkRecord(client, masterId, sourceId, fhirId, expectedVersion) {
  await lockMaster(client, masterId, expectedVersion);
  const link = await findLink(client, sourceId, fhirId);
  if (link.master_id === masterId) throw badRequest(`${sourceId}/Patient/${fhirId} is already linked to patient ${masterId}`);
  await client.query(`UPDATE patient_links SET master_id = $2, method = 'manual', score = NULL, linked_at = now() WHERE resource_id = $1`, [link.resource_id, masterId]);
  // The merge settles any possible-duplicate flag between the two masters.
  await removePossibleDuplicate(client, masterId, link.master_id);
  await removePossibleDuplicate(client, link.master_id, masterId);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM patient_links WHERE master_id = $1', [link.master_id]);
  const emptied = rows[0].n === 0;
  if (emptied) {
    await moveOpenFlags(client, link.master_id, masterId);
    await client.query('UPDATE master_patients SET merged_into = $2 WHERE id = $1', [link.master_id, masterId]);
  }
  await recomputeGolden(client, link.master_id, emptied ? `merged into ${masterId}` : `${sourceId}/Patient/${fhirId} moved to ${masterId}`, { always: emptied });
  return recomputeGolden(client, masterId, `linked ${sourceId}/Patient/${fhirId} manually`);
}

// A master emptied by a merge keeps no open questions: its unresolved possible
// duplicates are about the records that just left, so they follow them.
async function moveOpenFlags(client, emptiedId, survivorId) {
  const { rows } = await client.query('SELECT possible_duplicates FROM master_patients WHERE id = $1', [emptiedId]);
  for (const dup of rows[0].possible_duplicates) {
    await removePossibleDuplicate(client, dup.masterId, emptiedId);
    await addPossibleDuplicate(client, survivorId, dup);
    await addPossibleDuplicate(client, dup.masterId, { ...dup, masterId: survivorId });
    await recomputeGolden(client, dup.masterId, `possible duplicate now tracked on ${survivorId}`, { always: true });
  }
  await client.query(`UPDATE master_patients SET possible_duplicates = '[]' WHERE id = $1`, [emptiedId]);
}

/**
 * A steward confirms that a group of look-alike patients is one person. `expectedToken`
 * is the group's ETag from when they read it, so this only runs on that exact view:
 * a member edited, added or removed since then makes it a 412.
 *
 * By default everyone in the group is merged; `patients` narrows it to the ones that
 * are the same person (the rest stay flagged against the merged patient). The
 * survivor keeps its id, by default the oldest, and the others become tombstones
 * that redirect to it. Records move as manual links and remember where they came
 * from (`matched_on.mergedFrom`), so `unlink` can still split one back out.
 */
export async function confirmGroup(client, memberId, expectedToken, { patients = null, survivor = null } = {}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [MPI_LOCK]);
  const group = await loadGroupOf(client, memberId);
  if (!group) throw notFound(`Patient ${memberId} is not in a group of possible duplicates (it may have just been confirmed or dismissed)`);
  if (parseGroupEtag(group.etag) !== expectedToken) {
    throw preconditionFailed(`The group changed since it was read: If-Match was W/"${expectedToken}" but it is now ${group.etag}. Read it again before confirming.`);
  }

  const inGroup = new Set(group.members.map((m) => m.id));
  const selected = patients === null ? [...inGroup] : [...new Set(patients)];
  for (const id of selected) if (!inGroup.has(id)) throw badRequest(`Patient ${id} is not in this group`);
  if (selected.length < 2) throw badRequest('Choose at least two patients to confirm as one person');
  const survivorId = survivor ?? group.members.find((m) => selected.includes(m.id)).id; // members are oldest first
  if (!selected.includes(survivorId)) throw badRequest(`The survivor ${survivorId} must be one of the confirmed patients`);

  const plan = planConfirm(group.members, selected, survivorId);
  await client.query('SELECT id FROM master_patients WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...inGroup]]);

  await client.query(
    `UPDATE patient_links
     SET matched_on = jsonb_build_object('mergedFrom', master_id::text), master_id = $1, method = 'manual', score = NULL, linked_at = now()
     WHERE master_id = ANY($2::uuid[])`,
    [survivorId, plan.mergedAway],
  );
  const setFlags = (id, flags) => client.query('UPDATE master_patients SET possible_duplicates = $2::jsonb WHERE id = $1', [id, JSON.stringify(flags)]);
  await setFlags(survivorId, plan.survivorFlags);
  for (const [id, flags] of plan.outsiderFlags) await setFlags(id, flags);
  await client.query(
    `UPDATE master_patients SET possible_duplicates = '[]', needs_review = false, merged_into = $2 WHERE id = ANY($1::uuid[])`,
    [plan.mergedAway, survivorId],
  );

  const master = await recomputeGolden(client, survivorId, `confirmed ${selected.length} patients as one person`, { always: true });
  for (const id of plan.mergedAway) await recomputeGolden(client, id, `merged into ${survivorId}`, { always: true });
  for (const id of plan.outsiderFlags.keys()) await recomputeGolden(client, id, `possible duplicates now tracked on ${survivorId}`, { always: true });

  const { rows } = await client.query('SELECT count(*)::int AS n FROM patient_links WHERE master_id = $1', [survivorId]);
  return {
    survivor: survivorId,
    master,
    mergedAway: plan.mergedAway,
    records: rows[0].n,
    // Pinned values on a merged-away patient are not carried over; they stay in its history.
    overridesDropped: group.members.filter((m) => plan.mergedAway.includes(m.id) && Object.keys(m.overrides ?? {}).length).map((m) => m.id),
  };
}

/**
 * A steward decided flagged masters are different people: one pair when
 * `otherId` is given, otherwise every flag on this master.
 */
export async function dismissPossibleDuplicates(client, masterId, expectedVersion, otherId = null) {
  const master = await lockMaster(client, masterId, expectedVersion);
  const dismissed = master.possible_duplicates.filter((dup) => !otherId || dup.masterId === otherId);
  if (otherId && !dismissed.length) throw badRequest(`Patient ${otherId} is not flagged as a possible duplicate of ${masterId}`);
  for (const dup of dismissed) {
    await removePossibleDuplicate(client, dup.masterId, masterId);
    await removePossibleDuplicate(client, masterId, dup.masterId);
    await recomputeGolden(client, dup.masterId, `possible duplicate of ${masterId} dismissed`, { always: true });
  }
  return recomputeGolden(client, masterId, otherId ? `possible duplicate of ${otherId} dismissed` : 'possible duplicates dismissed', { always: dismissed.length > 0 });
}

async function removePossibleDuplicate(client, masterId, otherId) {
  await client.query(
    `UPDATE master_patients
     SET possible_duplicates = COALESCE((SELECT jsonb_agg(d) FROM jsonb_array_elements(possible_duplicates) d WHERE d->>'masterId' <> $2), '[]')
     WHERE id = $1`,
    [masterId, otherId],
  );
}

async function findLink(client, sourceId, fhirId) {
  const { rows } = await client.query(
    `SELECT pl.resource_id, pl.master_id FROM patient_links pl JOIN resources r ON r.id = pl.resource_id
     WHERE r.source_id = $1 AND r.resource_type = 'Patient' AND r.fhir_id = $2`,
    [sourceId, fhirId],
  );
  if (!rows[0]) throw notFound(`${sourceId}/Patient/${fhirId} has not been ingested`);
  return rows[0];
}

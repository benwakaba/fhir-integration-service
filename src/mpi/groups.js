// Groups of possible duplicates. Review flags are pairwise (A resembles B), but a
// steward decides about people: if A, B and C all resemble each other, that is one
// question, not three. A group is a connected set of golden patients under those
// flags. This file holds the pure parts (grouping, the group's ETag, what confirming
// a group does to the flags) and the queries that load groups; the merge itself,
// which needs the MPI lock and recomputes golden records, lives in index.js.

import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MEMBER_QUERY = `
  SELECT m.id, m.version_id, m.created_at, m.golden, m.overrides, m.possible_duplicates,
         COALESCE((SELECT array_agg(DISTINCT r.source_id ORDER BY r.source_id)
                   FROM patient_links pl JOIN resources r ON r.id = pl.resource_id
                   WHERE pl.master_id = m.id), '{}') AS sources,
         (SELECT count(*)::int FROM patient_links pl WHERE pl.master_id = m.id) AS records
  FROM master_patients m`;

// Oldest first: the oldest golden id is the one other systems are likeliest to hold.
const byAge = (a, b) => new Date(a.created_at) - new Date(b.created_at) || (a.id < b.id ? -1 : 1);

const flagsOf = (master) => master.possible_duplicates ?? [];

/**
 * The group's ETag. It covers every member's id and version, so it moves when anyone
 * joins or leaves, is edited, or gains or loses a review flag: confirming a group is
 * only possible on the view the steward actually read.
 */
export function groupEtag(members) {
  const key = members.map((m) => `${m.id}:${m.version_id}`).sort().join(',');
  return `W/"g-${createHash('sha256').update(key).digest('hex').slice(0, 16)}"`;
}

/** 'g-0123456789abcdef' from W/"g-0123456789abcdef" (or without the W/), else null. */
export function parseGroupEtag(header) {
  const match = /^\s*(?:W\/)?"(g-[0-9a-f]{16})"\s*$/.exec(header ?? '');
  return match ? match[1] : null;
}

/**
 * Connected components of the possible-duplicate graph, groups of two or more.
 * Each group lists its members oldest first and says whether every pair of members
 * is flagged (`complete`). A chain (A resembles B, B resembles C, A does not
 * resemble C) is a group but is not complete, and the steward should know.
 */
export function groupMasters(masters) {
  const byId = new Map(masters.map((m) => [m.id, m]));
  const parent = new Map(masters.map((m) => [m.id, m.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const pairs = new Set();
  for (const m of masters) {
    for (const d of flagsOf(m)) {
      if (!byId.has(d.masterId) || d.masterId === m.id) continue;
      parent.set(find(m.id), find(d.masterId));
      pairs.add([m.id, d.masterId].sort().join('|'));
    }
  }
  const components = new Map();
  for (const m of masters) {
    const root = find(m.id);
    components.set(root, [...(components.get(root) ?? []), m]);
  }
  return [...components.values()]
    .filter((members) => members.length > 1)
    .map((members) => {
      members.sort(byAge);
      const ids = new Set(members.map((m) => m.id));
      const flagged = [...pairs].filter((pair) => pair.split('|').every((id) => ids.has(id))).length;
      return {
        members,
        survivor: members[0].id,
        records: members.reduce((n, m) => n + m.records, 0),
        complete: flagged === (members.length * (members.length - 1)) / 2,
        etag: groupEtag(members),
      };
    });
}

/**
 * What confirming `selectedIds` as one person does to the review flags.
 *  - Flags between confirmed patients are settled and disappear.
 *  - Flags from a confirmed patient to anyone outside the selection move to the
 *    survivor, once per outsider.
 *  - An outsider's flags to confirmed patients are replaced by a single flag to the
 *    survivor, and the survivor is flagged back, so flags stay symmetric.
 * Everything the selection absorbs is `mergedAway`.
 */
export function planConfirm(members, selectedIds, survivorId) {
  const selected = new Set(selectedIds);
  const survivorFlags = new Map(); // outsider id -> flag entry (masterId = the outsider)
  for (const m of members) {
    if (!selected.has(m.id)) continue;
    for (const d of flagsOf(m)) if (!selected.has(d.masterId) && !survivorFlags.has(d.masterId)) survivorFlags.set(d.masterId, d);
  }

  const outsiderFlags = new Map(); // outsider id -> its new flags
  for (const m of members) {
    if (selected.has(m.id)) continue;
    const toConfirmed = flagsOf(m).find((d) => selected.has(d.masterId));
    const entry = toConfirmed ?? survivorFlags.get(m.id);
    if (!entry) continue;
    outsiderFlags.set(m.id, [...flagsOf(m).filter((d) => !selected.has(d.masterId)), { ...entry, masterId: survivorId }]);
    if (!survivorFlags.has(m.id)) survivorFlags.set(m.id, { ...entry, masterId: m.id });
  }
  return {
    survivorFlags: [...survivorFlags.values()],
    outsiderFlags,
    mergedAway: selectedIds.filter((id) => id !== survivorId),
  };
}

/**
 * What dismissing `dismissedIds` does to the review flags: the dismissed patients
 * are different people from everyone else in the group, so they lose every flag,
 * and anyone who was flagged against them loses that flag. Only patients whose
 * flags change are in the result (id -> their new flags); everyone else is
 * untouched and keeps their version.
 */
export function planDismiss(members, dismissedIds) {
  const dismissed = new Set(dismissedIds);
  const changes = new Map();
  for (const m of members) {
    const flags = flagsOf(m);
    const kept = dismissed.has(m.id) ? [] : flags.filter((d) => !dismissed.has(d.masterId));
    if (kept.length !== flags.length) changes.set(m.id, kept);
  }
  return changes;
}

/**
 * The pairs of patients a dismissal settles, to be remembered: every flag that
 * `planDismiss` removes, once per pair (flags are symmetric, so each shows up on both
 * sides). Same reach as planDismiss on purpose: what is remembered is what the steward
 * saw disappear. Two patients who were never flagged against each other are not
 * remembered as different, so a chain's unflagged ends can still be raised later.
 * Each pair comes back as [a, b] with a < b.
 */
export function dismissedPairs(members, dismissedIds) {
  const dismissed = new Set(dismissedIds);
  const pairs = new Map();
  for (const m of members) {
    for (const d of flagsOf(m)) {
      if (d.masterId === m.id || !(dismissed.has(m.id) || dismissed.has(d.masterId))) continue;
      const pair = m.id < d.masterId ? [m.id, d.masterId] : [d.masterId, m.id];
      pairs.set(pair.join('|'), pair);
    }
  }
  return [...pairs.values()];
}

function memberSummary(m) {
  const name = m.golden?.name?.[0];
  return {
    id: m.id,
    version: m.version_id,
    name: name ? [...(name.given ?? []), name.family].filter(Boolean).join(' ') || null : null,
    birthDate: m.golden?.birthDate ?? null,
    gender: m.golden?.gender ?? null,
    sources: m.sources,
    records: m.records,
    createdAt: m.created_at,
  };
}

/** A group as the API shows it. `id` is the survivor a confirm would keep by default. */
export function describeGroup(group) {
  const reasons = new Map();
  const counted = new Set();
  let minScore = null;
  for (const m of group.members) {
    for (const d of flagsOf(m)) {
      const pair = `${[m.id, d.masterId].sort().join('|')}|${d.reason}`;
      if (counted.has(pair)) continue; // a pair is flagged on both sides; count it once
      counted.add(pair);
      const key = String(d.reason ?? '').replace(/\(score [0-9.]+\)/, '(score N)');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      if (typeof d.score === 'number' && (minScore === null || d.score < minScore)) minScore = d.score;
    }
  }
  return {
    id: group.survivor,
    etag: group.etag,
    size: group.members.length,
    records: group.records,
    survivor: group.survivor,
    complete: group.complete,
    minScore,
    reasons: [...reasons].map(([reason, pairs]) => ({ reason, pairs })).sort((a, b) => b.pairs - a.pairs),
    patients: group.members.map(memberSummary),
  };
}

/** The golden patients with these ids, in the shape groups are built from (merged-away ones excluded). */
export async function loadMembers(db, ids) {
  const { rows } = await db.query(`${MEMBER_QUERY} WHERE m.id = ANY($1::uuid[]) AND m.merged_into IS NULL`, [ids]);
  return rows;
}

/** Every group, biggest (most source records) first. */
export async function loadGroups(db, { source = null } = {}) {
  const { rows } = await db.query(`${MEMBER_QUERY} WHERE m.merged_into IS NULL AND jsonb_array_length(m.possible_duplicates) > 0`);
  const groups = groupMasters(rows).filter((g) => !source || g.members.some((m) => m.sources.includes(source)));
  return groups.sort((a, b) => b.records - a.records || byAge(a.members[0], b.members[0]));
}

/**
 * The group a patient belongs to, found by following flags outward from it rather
 * than loading every flagged patient. Null when it has no possible duplicates.
 */
export async function loadGroupOf(db, memberId) {
  if (!UUID.test(memberId)) return null;
  const seen = new Map();
  let frontier = [memberId];
  while (frontier.length) {
    const { rows } = await db.query(`${MEMBER_QUERY} WHERE m.id = ANY($1::uuid[]) AND m.merged_into IS NULL`, [frontier]);
    for (const m of rows) seen.set(m.id, m);
    frontier = [...new Set(rows.flatMap((m) => flagsOf(m).map((d) => d.masterId)))].filter((id) => !seen.has(id));
  }
  return groupMasters([...seen.values()])[0] ?? null;
}

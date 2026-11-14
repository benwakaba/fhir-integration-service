// The terminology backlog: codes on stored resources that reach no internal
// concept, ranked by how many resources each one would unlock. It is the concept
// catalog's to-do list, read off the data instead of guessed: the first row is
// the mapping worth writing next. Each entry also says what kind of work it is,
// because "unmapped" covers very different problems: a valid LOINC code nobody
// has curated yet, a SNOMED or WHO ICD-10 code we cannot load, a vendor's local
// code, or a code that does not exist and has to be fixed where it was entered.

import { conceptsFor, exclusionsFor } from './concepts.js';
import { covers, findCodes, loadedSystems } from './service.js';
import { CODE_SYSTEMS, normalizeCoding, OTHER_STANDARD_SYSTEMS, unsupportedStandardNote } from './systems.js';

/** Resource types with a concept domain, and so with something to be mapped to. */
export const BACKLOG_TYPES = { Observation: 'observation', Condition: 'condition' };

const MALFORMED = new Set(['icd10cm-format', 'loinc-format', 'loinc-check-digit']);

/** True when any of these (normalized) codings is a member of a concept in the domain. */
export function reachesConcept(codings, domain) {
  return codings.some((c) => conceptsFor(c.system, c.code).some((m) => m.concept.domain === domain));
}

/** A JSON `coding` array as normalized codings; codings without a code carry nothing to map. */
export function normalizedCodings(value) {
  return (Array.isArray(value) ? value : [])
    .filter((c) => c && typeof c === 'object' && c.code !== undefined && c.code !== null && c.code !== '')
    .map(normalizeCoding);
}

/**
 * @param resourceType 'Observation' or 'Condition'
 * @param kind optional filter: unmapped | unsupported-system | local | invalid | excluded | no-system
 */
export async function terminologyBacklog(db, { resourceType, source = null, kind = null, limit = 50 }) {
  const domain = BACKLOG_TYPES[resourceType];
  // Grouped in SQL by the set of codings a resource carries, so a large store
  // arrives here as a few hundred distinct code sets rather than every resource.
  // An Observation is reached through its own code or a component's (a blood
  // pressure panel is mapped by its systolic and diastolic components).
  const { rows } = await db.query(
    `SELECT r.resource->'code'->'coding' AS codings,
            jsonb_path_query_array(r.resource, '$.component[*].code.coding[*]') AS component_codings,
            count(*)::int AS resources
     FROM resources r
     WHERE r.resource_type = $1 AND NOT r.deleted AND ($2::text IS NULL OR r.source_id = $2)
     GROUP BY 1, 2`,
    [resourceType, source],
  );

  let total = 0;
  let unmapped = 0;
  let withoutCoding = 0;
  const entries = new Map();
  for (const row of rows) {
    total += row.resources;
    const own = normalizedCodings(row.codings);
    if (reachesConcept([...own, ...normalizedCodings(row.component_codings)], domain)) continue;
    unmapped += row.resources;
    if (!own.length) {
      withoutCoding += row.resources;
      continue;
    }
    for (const coding of new Map(own.map((c) => [`${c.system}|${c.code}`, c])).values()) {
      const key = `${coding.system}|${coding.code}`;
      const entry = entries.get(key) ?? { system: coding.system, code: coding.code, display: null, problems: coding.problems, resources: 0 };
      entry.resources += row.resources;
      entry.display ??= coding.display ?? null;
      entries.set(key, entry);
    }
  }

  const all = [...entries.values()];
  const [systems, found] = await Promise.all([loadedSystems(db), findCodes(db, all)]);
  const described = all
    .map((entry) => describe(entry, systems, found, unmapped))
    .sort((a, b) => b.resources - a.resources || String(a.code).localeCompare(String(b.code)));

  const byKind = {};
  for (const entry of described) {
    byKind[entry.kind] ??= { codes: 0, resources: 0 };
    byKind[entry.kind].codes += 1;
    byKind[entry.kind].resources += entry.resources; // a resource with two unmapped codings counts under each
  }

  return {
    resourceType,
    source,
    resources: total,
    unmapped: { resources: unmapped, pct: pct(unmapped, total), withoutCoding },
    byKind,
    backlog: described.filter((entry) => !kind || entry.kind === kind).slice(0, limit),
  };
}

function describe(entry, systems, found, unmappedTotal) {
  const known = CODE_SYSTEMS[entry.system];
  const otherStandard = OTHER_STANDARD_SYSTEMS.get(entry.system);
  const release = systems.get(entry.system);
  const row = found.get(`${entry.system}|${entry.code}`);
  const excluded = exclusionsFor(entry.system, entry.code);
  const malformed = entry.problems.some((p) => MALFORMED.has(p));
  const missing = !row && covers(release, entry.system, entry.code);

  let kind = 'unmapped';
  let note = 'A valid code with no concept: a candidate for the catalog';
  if (!entry.system) {
    kind = 'no-system';
    note = 'No system, so the code cannot be interpreted: fix at the source';
  } else if (known?.unsupported) {
    kind = 'unsupported-system';
    note = known.unsupported;
  } else if (otherStandard) {
    kind = 'unsupported-system';
    note = unsupportedStandardNote(otherStandard);
  } else if (!known) {
    kind = 'local';
    note = 'Not a standard terminology: needs a mapping specific to this source';
  } else if (malformed || missing) {
    kind = 'invalid';
    note = `Not a valid ${known.name} code${missing ? ` in ${release.version}` : ''}: fix at the source, do not map`;
  } else if (excluded.length) {
    kind = 'excluded';
    note = excluded.map((x) => `Deliberately not ${x.concept}: ${x.reason}`).join('; ');
  }

  return {
    system: entry.system,
    code: entry.code,
    display: row?.display ?? entry.display,
    resources: entry.resources,
    pctOfUnmapped: pct(entry.resources, unmappedTotal),
    kind,
    note,
    ...(row && row.status !== 'active' && { status: row.status }),
  };
}

function pct(n, total) {
  return total ? Math.round((1000 * n) / total) / 10 : 0;
}

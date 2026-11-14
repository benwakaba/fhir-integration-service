// The terminology layer's read side: which code system releases are loaded, code
// lookups against them, and concept resolution for a single code.

import { CODE_SYSTEMS, LOINC, normalizeCoding, OTHER_STANDARD_SYSTEMS, unsupportedStandardNote } from './systems.js';
import { conceptsFor, exclusionsFor } from './concepts.js';

/** Map(url -> { url, name, version, content, includes, code_count, source, loaded_at }) */
export async function loadedSystems(db) {
  const { rows } = await db.query(
    'SELECT url, name, version, content, includes, code_count, source, loaded_at FROM code_systems ORDER BY url',
  );
  return new Map(rows.map((r) => [r.url, r]));
}

/** Map('system|code' -> row) for the pairs that exist in a loaded release. */
export async function findCodes(db, pairs) {
  const unique = [...new Map(pairs.filter((p) => p.system && p.code).map((p) => [`${p.system}|${p.code}`, p])).values()];
  if (!unique.length) return new Map();
  const { rows } = await db.query(
    `SELECT c.system, c.code, c.display, c.status, c.properties
     FROM codes c
     JOIN unnest($1::text[], $2::text[]) AS q(system, code) ON q.system = c.system AND q.code = c.code`,
    [unique.map((p) => p.system), unique.map((p) => p.code)],
  );
  return new Map(rows.map((r) => [`${r.system}|${r.code}`, r]));
}

// LOINC releases are several files: terms (Loinc.csv), answers and answer lists
// (AnswerList.csv) and parts (Part.csv). A code's prefix says which it is.
const LOINC_KINDS = { LA: 'answers', LL: 'answer-lists', LP: 'parts', LG: 'groups' };

export function loincKind(code) {
  return LOINC_KINDS[/^(L[APGL])\d/.exec(code ?? '')?.[1]] ?? 'terms';
}

/**
 * Can this release say a code does not exist? Only if it is complete and, for
 * LOINC, the kind of code in question (term, answer, part) was part of the load.
 */
export function covers(release, system, code) {
  if (release?.content !== 'complete') return false;
  return system !== LOINC || (release.includes ?? []).includes(loincKind(code));
}

/**
 * Everything the service knows about one code: its canonical form, what the loaded
 * release says about it, and which internal concepts it maps to (or is excluded from).
 */
export async function lookupCode(db, system, code) {
  const normalized = normalizeCoding({ system, code });
  const systems = await loadedSystems(db);
  const release = systems.get(normalized.system);
  const row = (await findCodes(db, [normalized])).get(`${normalized.system}|${normalized.code}`);
  const known = CODE_SYSTEMS[normalized.system];
  const otherStandard = OTHER_STANDARD_SYSTEMS.get(normalized.system);

  return {
    input: { system, code },
    system: normalized.system,
    code: normalized.code,
    normalization: normalized.problems.filter((p) => p !== 'missing-system'),
    systemName: known?.name ?? otherStandard ?? null,
    supported: Boolean(known) && !known.unsupported,
    note: known?.unsupported ?? (otherStandard && unsupportedStandardNote(otherStandard)),
    release: release
      ? { version: release.version, content: release.content, includes: release.includes, source: release.source }
      : null,
    found: row
      ? { display: row.display, status: row.status, properties: row.properties }
      : covers(release, normalized.system, normalized.code)
        ? false // this kind of code is loaded in full and it is not there: it does not exist
        : null, // unknown: only a fragment (or nothing) of this system or kind of code is loaded
    concepts: conceptsFor(normalized.system, normalized.code).map(({ concept, member }) => ({
      id: concept.id,
      display: concept.display,
      domain: concept.domain,
      matchedBy: member.match === 'exact' ? `${member.code}` : `${member.code} and descendants`,
      ...(member.note && { note: member.note }),
    })),
    excludedFrom: exclusionsFor(normalized.system, normalized.code),
  };
}

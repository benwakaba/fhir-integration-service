// Patient matching: decide whether an incoming source Patient is someone we
// already have. Identity needs a shared identifier:
//   1. a trusted person identifier (SSN, NHS number) links on its own, unless
//      birthDate or gender contradicts it;
//   2. any other identifier shared exactly (an MRN or member id: same system URI,
//      same value) links only when name and birthDate agree as well;
//   3. name and birthDate alone never link. They nominate review candidates for a
//      steward, because two people can share a name and a birthday, and a wrong
//      merge puts one person's results in another person's chart.
// Candidates are found with GIN containment queries on the stored JSON; scoring
// happens here.

import { canonicalIdentifierSystem, identifierKey, SSN } from './survivorship.js';

// Identifier systems that identify a person across organizations, with the shape
// a real value has. Malformed values are not trusted: the SMART sandbox has
// records for different people sharing the "SSN" 56TYRU. An MRN is not here: it
// identifies a record only inside the namespace that issued it (sharedIdentifiers).
export const TRUSTED_IDENTIFIER_SYSTEMS = new Map([
  [SSN, /^\d{3}-?\d{2}-?\d{4}$/],
  ['https://fhir.nhs.uk/Id/nhs-number', /^\d{3} ?\d{3} ?\d{4}$/],
  ['https://github.com/synthetichealth/synthea', /^[0-9a-f-]{36}$/i], // Synthea's person id: the same synthetic person across exports
]);

// Values feeds use as placeholders, including unrendered templates ({{ssn}}).
const PLACEHOLDER = /^(0+|9{9}|123456789|unknown|none|n\/?a)$|\{\{|\}\}/i;

// Demographic score at which two records are worth a steward's attention. This
// was once an auto-link threshold; nothing links on demographics any more.
export const CANDIDATE_THRESHOLD = 0.85;

/** Trusted identifiers of a Patient, normalized: [{ system, value, key }] */
export function trustedIdentifiers(patient) {
  return (patient.identifier ?? [])
    .map((id) => ({ system: canonicalIdentifierSystem(id.system), value: id.value }))
    .filter((id) => typeof id.value === 'string' && TRUSTED_IDENTIFIER_SYSTEMS.get(id.system)?.test(id.value.trim()))
    .filter((id) => !PLACEHOLDER.test(id.value.replace(/[^\w{}]/g, '')))
    .map((id) => ({ ...id, key: identifierKey(id) }));
}

/**
 * JSONB containment patterns that find stored Patients carrying the same
 * identifier. Stored JSON is as-sent, so every spelling a source might use is
 * queried: both SSN system URIs, with and without dashes.
 */
export function identifierPatterns({ system, value }) {
  if (system !== SSN) return [{ identifier: [{ system, value }] }];
  const digits = value.replace(/\D/g, '');
  const dashed = digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : value;
  const patterns = [];
  for (const sys of [SSN, 'urn:oid:2.16.840.1.113883.4.1']) {
    for (const v of new Set([digits, dashed, value])) patterns.push({ identifier: [{ system: sys, value: v }] });
  }
  return patterns;
}

// Values too generic to be evidence when two records share them: "12345" is the
// MRN on half the example patients ever written.
const WORDS = /^(test|sample|example|demo|dummy|fake)\d*$|^(unknown|none|na|mrn|id|patient)$/i;

function meaningful(value) {
  if (typeof value !== 'string' || PLACEHOLDER.test(value.replace(/[^\w{}]/g, ''))) return false;
  const v = value.replace(/[^a-z0-9]/gi, '');
  return v.length >= 4 && !/^(.)\1+$/.test(v) && !'01234567890'.includes(v) && !WORDS.test(v);
}

/**
 * Systems under which two records carry exactly the same identifier value.
 * Outside the trusted systems such an identifier (an MRN, a member id) means
 * something only inside the namespace that issued it, and namespaces in test data
 * are reused, so on its own it links nothing. With name and birthDate agreeing as
 * well, it is one record seen twice.
 */
export function sharedIdentifiers(a, b) {
  const keys = (patient) =>
    new Map(
      (patient.identifier ?? [])
        .filter((id) => typeof id?.system === 'string' && id.system && meaningful(id.value))
        .map((id) => [`${canonicalIdentifierSystem(id.system)}|${id.value.trim()}`, canonicalIdentifierSystem(id.system)]),
    );
  const other = keys(b);
  return [...new Set([...keys(a)].filter(([key]) => other.has(key)).map(([, system]) => system))];
}

/**
 * Does this record contradict a candidate on identity? A shared identifier with a
 * different full birthDate or gender is more likely a reused or mistyped
 * identifier than one person: merging two people's charts is worse than keeping
 * a duplicate, so such matches are flagged for review instead of linked.
 */
export function contradicts(a, b) {
  const full = /^\d{4}-\d{2}-\d{2}$/;
  if (full.test(a.birthDate ?? '') && full.test(b.birthDate ?? '') && a.birthDate !== b.birthDate) return 'birthDate differs';
  if (a.gender && b.gender && a.gender !== b.gender && ![a.gender, b.gender].includes('unknown')) return 'gender differs';
  return null;
}

/**
 * Trusted identifier systems both records carry with no value in common, e.g.
 * two different SSNs. For a steward that is evidence the two are different
 * people, or that one identifier was mistyped; either way worth saying.
 */
export function differingIdentifiers(a, b) {
  const bySystem = (patient) => {
    const map = new Map();
    for (const id of trustedIdentifiers(patient)) map.set(id.system, [...(map.get(id.system) ?? []), id.key]);
    return map;
  };
  const [ia, ib] = [bySystem(a), bySystem(b)];
  return [...ia.keys()].filter((system) => ib.has(system) && !ia.get(system).some((key) => ib.get(system).includes(key)));
}

/**
 * Demographic score in [0, 1] for two Patients that share a birthDate (the
 * blocking key). Gender disagreement or an unrelated name scores 0.
 */
export function demographicScore(a, b) {
  if (a.gender && b.gender && a.gender !== b.gender) return 0;
  let best = 0;
  for (const na of a.name ?? []) {
    for (const nb of b.name ?? []) {
      const family = nameSimilarity(na.family, nb.family);
      const given = givenSimilarity(na.given?.[0], nb.given?.[0]);
      if (family === 0 || given === 0) continue;
      best = Math.max(best, family + given);
    }
  }
  if (best === 0) return 0;
  if (sharesPostalCode(a, b)) best += 0.1;
  if (sharesPhone(a, b)) best += 0.1;
  return Math.min(1, Math.round(best * 1000) / 1000);
}

function nameSimilarity(x, y) {
  const [a, b] = [simplify(x), simplify(y)];
  if (!a || !b) return 0;
  if (a === b) return 0.5;
  return jaroWinkler(a, b) >= 0.9 ? 0.35 : 0; // typo-level difference
}

function givenSimilarity(x, y) {
  const [a, b] = [simplify(x), simplify(y)];
  if (!a || !b) return 0;
  if (a === b) return 0.4;
  if (jaroWinkler(a, b) >= 0.88 || a.startsWith(b) || b.startsWith(a)) return 0.25; // Sandi / Sandra, J / John
  return 0;
}

function sharesPostalCode(a, b) {
  const zips = (p) => new Set((p.address ?? []).map((ad) => String(ad.postalCode ?? '').slice(0, 5)).filter(Boolean));
  const za = zips(a);
  return [...zips(b)].some((z) => za.has(z));
}

function sharesPhone(a, b) {
  const phones = (p) =>
    new Set((p.telecom ?? []).filter((t) => t.system === 'phone').map((t) => String(t.value ?? '').replace(/\D/g, '').slice(-10)).filter(Boolean));
  const pa = phones(a);
  return [...phones(b)].some((p) => pa.has(p));
}

function simplify(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/** Jaro-Winkler similarity, the standard record-linkage string metric. */
export function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(s2.length, i + window + 1); j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0, k = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, s1.length, s2.length) && s1[prefix] === s2[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

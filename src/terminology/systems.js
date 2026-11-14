// Code system identity: canonical URIs, the aliases real sources send instead of
// them, and code-level normalization (ICD-10-CM dots, LOINC check digits).

export const LOINC = 'http://loinc.org';
export const ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm';
export const SNOMED = 'http://snomed.info/sct';
export const UCUM = 'http://unitsofmeasure.org';
export const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

/** The systems the terminology layer knows how to load and map. */
export const CODE_SYSTEMS = {
  [LOINC]: { name: 'LOINC', param: 'loinc' },
  [ICD10CM]: { name: 'ICD-10-CM', param: 'icd10cm' },
  [SNOMED]: {
    name: 'SNOMED CT',
    param: 'snomed',
    unsupported: 'SNOMED CT content requires a UMLS license and is not loaded; codings are stored and reported but not mapped.',
  },
};

// Non-canonical URIs seen in the wild, keyed lowercase. Note what is deliberately
// NOT here: http://hl7.org/fhir/sid/icd-10 is WHO ICD-10, a different code system
// from the US clinical modification, and is never silently treated as ICD-10-CM.
const ALIASES = new Map([
  ['urn:oid:2.16.840.1.113883.6.1', LOINC],
  ['http://loinc.org/', LOINC],
  ['https://loinc.org', LOINC],
  ['https://loinc.org/', LOINC],
  ['loinc', LOINC],
  ['ln', LOINC],
  ['urn:oid:2.16.840.1.113883.6.90', ICD10CM],
  ['http://www.cdc.gov/nchs/icd/icd10cm.htm', ICD10CM],
  ['https://www.cdc.gov/nchs/icd/icd10cm.htm', ICD10CM],
  ['http://hl7.org/fhir/sid/icd-10-cm/', ICD10CM],
  ['icd-10-cm', ICD10CM],
  ['icd10cm', ICD10CM],
  ['urn:oid:2.16.840.1.113883.6.96', SNOMED],
  ['http://snomed.info/sct/', SNOMED],
  ['https://snomed.info/sct', SNOMED],
  ['snomed', SNOMED],
  ['snomedct', SNOMED],
  ['sct', SNOMED],
  ['urn:oid:2.16.840.1.113883.6.8', UCUM],
  ['urn:oid:2.16.840.1.113883.6.88', RXNORM],
]);

const CANONICAL_BY_LOWER = new Map(
  [LOINC, ICD10CM, SNOMED, UCUM, RXNORM].map((url) => [url.toLowerCase(), url]),
);

/** The canonical URI for a system as sent by a source (unknown systems pass through trimmed). */
export function canonicalSystem(system) {
  if (typeof system !== 'string') return null;
  const trimmed = system.trim();
  const key = trimmed.toLowerCase();
  return CANONICAL_BY_LOWER.get(key) ?? ALIASES.get(key) ?? trimmed;
}

/** Resolve an API parameter ('loinc', 'icd10cm', 'snomed' or any URI/alias) to a canonical URI. */
export function resolveSystemParam(value) {
  if (!value) return null;
  const byParam = Object.entries(CODE_SYSTEMS).find(([, s]) => s.param === value.toLowerCase());
  return byParam ? byParam[0] : canonicalSystem(value);
}

// ICD-10-CM: letter, digit, alphanumeric, then an optional dot and 1-4 more characters.
export const ICD10CM_PATTERN = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;

// LOINC term codes are digits-dash-check digit; LA/LP/LG/LL prefix answer, part and group codes.
export const LOINC_PATTERN = /^(L[APGL])?(\d{1,7})-(\d)$/;

/**
 * LOINC's Mod 10 check digit (LOINC Users' Guide): double every other digit
 * starting from the rightmost, sum the digits of the results plus the untouched
 * digits, and take the distance to the next multiple of ten.
 */
export function loincCheckDigit(digits) {
  let sum = 0;
  [...digits].reverse().forEach((ch, i) => {
    const d = Number(ch);
    if (i % 2 === 0) {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += d;
    }
  });
  return (10 - (sum % 10)) % 10;
}

/**
 * Normalize a code for its (canonical) system. Returns the normalized code and,
 * when the source form had to be repaired or is unusable, a machine-readable problem.
 */
export function normalizeCode(system, rawCode) {
  if (typeof rawCode !== 'string' || !rawCode.trim()) return { code: rawCode, problem: 'missing-code' };
  const trimmed = rawCode.trim();

  if (system === ICD10CM) {
    const upper = trimmed.toUpperCase();
    // Release files and many feeds omit the dot: E119 is E11.9.
    const dotted = /^[A-Z][0-9][0-9A-Z][0-9A-Z]{1,4}$/.test(upper) ? `${upper.slice(0, 3)}.${upper.slice(3)}` : upper;
    if (!ICD10CM_PATTERN.test(dotted)) return { code: trimmed, problem: 'icd10cm-format' };
    if (dotted !== trimmed) return { code: dotted, problem: dotted.replace('.', '') === upper ? 'icd10cm-undotted' : 'icd10cm-case' };
    return { code: dotted };
  }

  if (system === LOINC) {
    const match = LOINC_PATTERN.exec(trimmed);
    if (!match) return { code: trimmed, problem: 'loinc-format' };
    // Only term codes are checked: answer/part codes (LA33-6 "Yes") do not follow
    // the term-code Mod 10 rule, and a false "invalid code" is worse than none.
    if (!match[1] && loincCheckDigit(match[2]) !== Number(match[3])) return { code: trimmed, problem: 'loinc-check-digit' };
    return { code: trimmed };
  }

  if (trimmed !== rawCode) return { code: trimmed, problem: 'whitespace' };
  return { code: trimmed };
}

/**
 * Canonical (system, code) for a Coding, plus what had to be repaired to get
 * there. This is the one place the rest of the service normalizes codings.
 */
export function normalizeCoding(coding) {
  const system = canonicalSystem(coding?.system);
  const { code, problem } = normalizeCode(system, coding?.code);
  const problems = [];
  if (!coding?.system) problems.push('missing-system');
  else if (system !== coding.system) problems.push('system-alias');
  if (problem) problems.push(problem);
  return { system, code, display: coding?.display, problems };
}

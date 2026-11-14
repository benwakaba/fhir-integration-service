// Layer 3: codes checked against the terminology layer. Unlike layers 1-2 this
// needs the database, because whether a code exists depends on which LOINC and
// ICD-10-CM releases are loaded. Existence is only asserted for systems loaded in
// full (content = 'complete'); a seed fragment can confirm codes but never deny them.

import { covers, loincKind } from '../terminology/service.js';
import { CODE_SYSTEMS, LOINC, loincCheckDigit, LOINC_PATTERN, normalizeCoding } from '../terminology/systems.js';
import { Category, issue } from './issues.js';

/** Every Coding in a resource with its JSON pointer (meta tags and security labels excluded). */
export function collectCodings(resource) {
  const found = [];
  const visit = (node, pointer) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${pointer}/${i}`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (pointer === '' && (key === 'meta' || key === 'text' || key === 'contained')) continue;
      if (key === 'coding' && Array.isArray(value)) {
        value.forEach((c, i) => c && typeof c === 'object' && found.push({ coding: c, pointer: `${pointer}/coding/${i}` }));
      } else if (key === 'valueCoding' && value && typeof value === 'object') {
        found.push({ coding: value, pointer: `${pointer}/valueCoding` });
      } else {
        visit(value, `${pointer}/${key}`);
      }
    }
  };
  visit(resource, '');
  if (resource.resourceType === 'Encounter' && resource.class && typeof resource.class === 'object') {
    found.push({ coding: resource.class, pointer: '/class' }); // Encounter.class is a bare Coding
  }
  return found;
}

const FORMAT_PROBLEMS = new Set(['icd10cm-format', 'loinc-format', 'loinc-check-digit', 'missing-code']);

const KIND_NOUN = { terms: 'a code', answers: 'an answer code', 'answer-lists': 'an answer list', parts: 'a part code', groups: 'a group code' };

export function terminologyIssues(resource, codings, { systems, codes }) {
  const issues = [];
  const add = (severity, rule, pointer, message) =>
    issues.push(issue({ severity, category: Category.INVALID_CODE, rule, resourceType: resource.resourceType, pointer, message }));

  for (const { coding, pointer } of codings) {
    if (coding.system === undefined && coding.code === undefined) continue; // display-only coding
    const n = normalizeCoding(coding);
    const name = CODE_SYSTEMS[n.system]?.name ?? n.system;
    for (const problem of n.problems) {
      switch (problem) {
        case 'missing-system':
          add('warning', 'coding-without-system', pointer, `Code '${coding.code}' has no system, so it cannot be interpreted outside the source`);
          break;
        case 'missing-code':
          add('warning', 'coding-without-code', pointer, `Coding for ${name} has no code`);
          break;
        case 'system-alias':
          add('warning', 'non-canonical-system', `${pointer}/system`, `'${coding.system}' is a non-canonical URI for ${name}; the canonical system is ${n.system}`);
          break;
        case 'icd10cm-undotted':
          add('warning', 'icd10cm-undotted', `${pointer}/code`, `ICD-10-CM code '${coding.code}' is missing its dot; the FHIR form is '${n.code}'`);
          break;
        case 'icd10cm-case':
        case 'whitespace':
          add('warning', 'code-not-normalized', `${pointer}/code`, `Code '${coding.code}' should be sent as '${n.code}'`);
          break;
        case 'icd10cm-format':
          add('error', 'malformed-code', `${pointer}/code`, `'${coding.code}' is not a well-formed ICD-10-CM code`);
          break;
        case 'loinc-format':
          add('error', 'malformed-code', `${pointer}/code`, `'${coding.code}' is not a well-formed LOINC code`);
          break;
        case 'loinc-check-digit': {
          const [, prefix = '', digits] = LOINC_PATTERN.exec(n.code);
          // State the arithmetic, not a correction: the digits with a valid check digit
          // are usually an unrelated test, not what the source meant.
          add('error', 'loinc-check-digit', `${pointer}/code`, `'${coding.code}' fails LOINC's Mod 10 check digit (${prefix}${digits} would need -${loincCheckDigit(digits)}), so it is not a LOINC code`);
          break;
        }
        default:
          break;
      }
    }

    const release = systems.get(n.system);
    if (release?.content !== 'complete' || n.problems.some((p) => FORMAT_PROBLEMS.has(p))) continue;
    const row = codes.get(`${n.system}|${n.code}`);
    const replacement = row?.properties?.mapTo?.length ? `; LOINC's replacement is ${row.properties.mapTo.join(', ')}` : '';
    if (!row) {
      // Say "does not exist" only about a kind of code the release actually covers:
      // a load of LOINC terms knows nothing about answer codes (LA...).
      if (!covers(release, n.system, n.code)) continue;
      const what = n.system === LOINC ? KIND_NOUN[loincKind(n.code)] : 'a code';
      add('error', 'unknown-code', `${pointer}/code`, `'${n.code}' is not ${what} in ${name} ${release.version ?? ''}`.trim());
    } else if (row.status === 'header') {
      add('warning', 'non-billable-code', `${pointer}/code`, `'${n.code}' is an ICD-10-CM category header, not a codable diagnosis; a more specific code is required`);
    } else if (row.status === 'deprecated') {
      add('warning', 'deprecated-code', `${pointer}/code`, `${name} code '${n.code}' is deprecated${replacement}`);
    } else if (row.status === 'discouraged' && n.system === LOINC) {
      add('warning', 'discouraged-code', `${pointer}/code`, `LOINC '${n.code}' is discouraged${replacement}`);
    }
  }
  return issues;
}

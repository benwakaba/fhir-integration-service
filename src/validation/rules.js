// Layer 2: checks the JSON Schema cannot express, driven by rules generated from
// the official R4 and US Core packages (scripts/build-validation-rules.js).

import { readFileSync } from 'node:fs';
import { Category, issue, nodesAt, toFhirPath } from './issues.js';

export const RULES = JSON.parse(readFileSync(new URL('./generated/r4-rules.json', import.meta.url), 'utf-8'));

const KNOWN_EXTENSIONS = new Set(RULES.knownExtensions);
const BINDINGS = new Map(
  Object.entries(RULES.resources).map(([type, r]) => [
    type,
    r.requiredBindings.map((b) => ({ ...b, allowed: new Set(b.codes) })),
  ]),
);

export function ruleIssues(resource) {
  const type = resource.resourceType;
  const issues = [];
  const rules = RULES.resources[type];
  if (rules) {
    for (const rule of rules.requiredPrimitives) checkRequiredPrimitive(resource, rule, issues);
    for (const rule of BINDINGS.get(type)) checkRequiredBinding(resource, rule, issues);
  }
  walk(resource, '', type, issues);
  return issues;
}

// A required primitive may be present as its value or, with no value, as `_element`
// carrying an extension (e.g. a data-absent-reason). Either satisfies min = 1.
function checkRequiredPrimitive(resource, { path, variants }, issues) {
  const segments = path.split('.');
  const leaf = segments.pop();
  const names = variants ?? [leaf];
  for (const { node, pointer } of nodesAt(resource, segments)) {
    if (!node || typeof node !== 'object') continue;
    if (names.some((n) => node[n] !== undefined || node[`_${n}`] !== undefined)) continue;
    issues.push(
      issue({
        category: Category.MISSING_REQUIRED,
        rule: 'required-element',
        resourceType: resource.resourceType,
        pointer: `${pointer}/${leaf}`,
        message: `${resource.resourceType}.${path} is required (min cardinality 1)`,
      }),
    );
  }
}

function checkRequiredBinding(resource, { path, type, valueSet, allowed }, issues) {
  for (const { node, pointer } of nodesAt(resource, path.split('.'))) {
    const codings = type === 'Coding' ? [node] : Array.isArray(node?.coding) ? node.coding : [];
    if (codings.some((c) => allowed.has(`${c?.system}|${c?.code}`))) continue;
    const allowedCodes = [...allowed].map((s) => s.split('|')[1]);
    const expectedSystem = [...allowed][0].split('|')[0];
    // A common migration bug: the right code under the pre-R4 system URI.
    const wrongSystem = codings.find((c) => allowedCodes.includes(c?.code) && c?.system !== expectedSystem);
    const vsName = valueSet.split('/').pop();
    issues.push(
      issue({
        category: Category.INVALID_CODE,
        rule: 'required-binding',
        resourceType: resource.resourceType,
        pointer,
        message: !wrongSystem
          ? `${resource.resourceType}.${path} has no coding from the required value set ${vsName} (${allowedCodes.join(' | ')})`
          : wrongSystem.system
            ? `${resource.resourceType}.${path}: code '${wrongSystem.code}' is right but the system '${wrongSystem.system}' is not; R4 requires ${expectedSystem}`
            : `${resource.resourceType}.${path}: code '${wrongSystem.code}' has no system; R4 requires ${expectedSystem}`,
      }),
    );
  }
}

// One recursive pass for everything that can occur at any depth: extensions
// (known? url present?) and the JSON rule that objects and arrays may not be empty.
function walk(node, pointer, resourceType, issues) {
  if (Array.isArray(node)) {
    if (node.length === 0) issues.push(emptyIssue(resourceType, pointer));
    node.forEach((item, i) => walk(item, `${pointer}/${i}`, resourceType, issues));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (pointer && Object.keys(node).length === 0) {
    issues.push(emptyIssue(resourceType, pointer));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const childPointer = `${pointer}/${key}`;
    if ((key === 'extension' || key === 'modifierExtension') && Array.isArray(value)) {
      value.forEach((ext, i) => checkExtension(ext, `${childPointer}/${i}`, key === 'modifierExtension', resourceType, issues));
    }
    if (key === 'contained') {
      // Contained resources are their own resource type; validate them with their own rules.
      (Array.isArray(value) ? value : []).forEach((inner, i) => {
        if (!inner?.resourceType) return;
        for (const found of ruleIssues(inner)) {
          issues.push({
            ...found,
            path: `${resourceType}.contained[${i}]${found.path.slice(inner.resourceType.length)}`,
            element: `${resourceType}.contained${found.element.slice(inner.resourceType.length)}`,
          });
        }
      });
      continue;
    }
    walk(value, childPointer, resourceType, issues);
  }
}

function checkExtension(ext, pointer, modifier, resourceType, issues) {
  const url = ext?.url;
  if (typeof url !== 'string' || !url) {
    issues.push(
      issue({
        category: Category.MISSING_REQUIRED,
        rule: 'extension-url',
        resourceType,
        pointer: `${pointer}/url`,
        message: 'Extension.url is required',
      }),
    );
    return;
  }
  // Sub-extensions of a complex extension use relative names ('ombCategory'); only
  // absolute URLs identify an extension definition.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || KNOWN_EXTENSIONS.has(url)) return;
  const element = toFhirPath(resourceType, pointer.replace(/\/\d+$/, '')).replace(/\[\d+\]/g, '');
  issues.push(
    issue({
      // An unknown modifier extension changes the meaning of the element it sits on,
      // so the resource cannot be safely processed; a plain one can be ignored.
      severity: modifier ? 'error' : 'warning',
      category: Category.UNKNOWN_EXTENSION,
      rule: modifier ? 'unknown-modifier-extension' : 'unknown-extension',
      resourceType,
      pointer,
      element: `${element}('${url}')`,
      message: modifier
        ? `Unknown modifier extension ${url}: the resource cannot be safely interpreted without it`
        : `Extension ${url} is not defined in FHIR R4 core or US Core 6.1.0`,
    }),
  );
}

function emptyIssue(resourceType, pointer) {
  return issue({
    category: Category.INVALID_VALUE,
    rule: 'empty-element',
    resourceType,
    pointer,
    message: 'Empty objects and arrays are not allowed in FHIR JSON (ele-1)',
  });
}

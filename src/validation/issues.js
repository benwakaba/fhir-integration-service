// One issue shape for every validation layer, so reports can aggregate them.

export const Category = {
  MISSING_REQUIRED: 'missing-required',
  CARDINALITY: 'cardinality',
  INVALID_CODE: 'invalid-code',
  UNKNOWN_EXTENSION: 'unknown-extension',
  // Beyond the four headline categories: structural problems that are neither.
  UNKNOWN_ELEMENT: 'unknown-element',
  INVALID_VALUE: 'invalid-value',
};

/**
 * @param pointer JSON pointer into the resource ('/name/0/given'), or a FHIRPath
 *   element override via `element` for issues keyed by something other than a path.
 */
export function issue({ severity = 'error', category, rule, resourceType, pointer = '', element, message }) {
  const path = toFhirPath(resourceType, pointer);
  return { severity, category, rule, path, element: element ?? path.replace(/\[\d+\]/g, ''), message };
}

/** '/name/0/given/1' -> 'Patient.name[0].given[1]' */
export function toFhirPath(resourceType, pointer) {
  let out = resourceType;
  for (const segment of pointer.split('/').slice(1)) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    out += /^\d+$/.test(key) ? `[${key}]` : `.${key}`;
  }
  return out;
}

/** Value at a JSON pointer, or undefined. */
export function valueAt(root, pointer) {
  let node = root;
  for (const segment of pointer.split('/').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/** Every node reached by walking a dotted path through objects and arrays, with its pointer. */
export function* nodesAt(root, segments, pointer = '') {
  if (!segments.length) {
    yield { node: root, pointer };
    return;
  }
  const [head, ...rest] = segments;
  const value = root?.[head];
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* nodesAt(value[i], rest, `${pointer}/${head}/${i}`);
  } else {
    yield* nodesAt(value, rest, `${pointer}/${head}`);
  }
}

export const hasErrors = (issues) => issues.some((i) => i.severity === 'error');

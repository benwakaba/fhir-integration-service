// Reference parsing. A source's references live in that source's id space:
// 'Patient/123' from SMART and 'Patient/123' from HAPI are different people.

const REFERENCE = /^(?:(.+)\/)?([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/([^/]+))?$/;

/** { base, type, id, version } for a literal reference; null for contained, urn or malformed ones. */
export function parseReference(reference) {
  if (typeof reference !== 'string' || reference.startsWith('#') || reference.startsWith('urn:')) return null;
  const match = REFERENCE.exec(reference.trim());
  if (!match) return null;
  const [, base, type, id, version] = match;
  return { base: base ?? null, type, id, version: version ?? null };
}

export function sameBase(a, b) {
  const norm = (url) => url?.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** True when a parsed reference points into the given source (relative, or absolute to its base). */
export function isLocal(parsed, sourceBase) {
  return Boolean(parsed) && (parsed.base === null || sameBase(parsed.base, sourceBase));
}

// Elements that place a resource in a patient's compartment, in priority order.
const PATIENT_ELEMENTS = ['subject', 'patient', 'beneficiary'];

/** 'Patient/<id>' this resource belongs to, in the source's id space, or null. */
export function patientRefOf(resource, sourceBase) {
  if (resource.resourceType === 'Patient') return resource.id ? `Patient/${resource.id}` : null;
  for (const element of PATIENT_ELEMENTS) {
    const value = resource[element];
    for (const ref of Array.isArray(value) ? value : [value]) {
      const parsed = parseReference(ref?.reference);
      if (parsed?.type === 'Patient' && isLocal(parsed, sourceBase)) return `Patient/${parsed.id}`;
    }
  }
  return null;
}

import { createHash } from 'node:crypto';

// Content identity. Servers bump meta.versionId/lastUpdated on saves that change
// nothing, so the hash covers the resource without them: two versions with the
// same hash are the same clinical content, whatever the source's version says.
const HASHED_META = ['profile', 'security', 'tag'];

export function contentHash(resource) {
  const { meta, ...rest } = resource;
  const kept = {};
  for (const key of HASHED_META) if (meta?.[key] !== undefined) kept[key] = meta[key];
  const body = Object.keys(kept).length ? { ...rest, meta: kept } : rest;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** JSON with object keys sorted at every level, so equal content serializes identically. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

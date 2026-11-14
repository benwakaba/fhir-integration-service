// How stored rows are shown to API clients: local versioning in meta and ETag,
// provenance in meta.source, and OperationOutcomes for errors and validation.

import { config } from '../config.js';

export const FHIR_JSON = 'application/fhir+json';

export const etag = (versionId) => `W/"${versionId}"`;

/** Version from an ETag / If-Match value: W/"3", "3" -> 3. Null if absent or malformed. */
export function parseEtag(header) {
  const match = /^\s*(?:W\/)?"(\d+)"\s*$/.exec(header ?? '');
  return match ? Number(match[1]) : null;
}

/** Absolute URL of a source resource on this service's FHIR facade. */
export function facadeUrl(sourceId, type, id) {
  return `${config.publicBaseUrl}/fhir/${sourceId}/${type}/${id}`;
}

/**
 * A stored row as a FHIR resource: meta.versionId/lastUpdated are this service's
 * (they back the ETag), and meta.source says exactly which source version it came from.
 */
export function present(row, source) {
  // JSONB stores object keys shortest-first; restore FHIR's conventional order.
  const { resourceType, id: _id, meta: storedMeta, ...rest } = structuredClone(row.resource);
  const { versionId, lastUpdated, source: _ignored, ...meta } = storedMeta ?? {};
  return {
    resourceType,
    id: row.fhir_id,
    meta: {
      ...meta,
      versionId: String(row.version_id),
      lastUpdated: row.updated_at.toISOString(),
      source: provenance(row, source, versionId),
    },
    ...rest,
  };
}

function provenance(row, source, sourceVersionInBody) {
  const version = row.source_version_id ?? sourceVersionInBody;
  if (!source?.base_url) return `urn:fhir-integration-service:source:${row.source_id}`;
  return `${source.base_url}/${row.resource_type}/${row.fhir_id}${version ? `/_history/${version}` : ''}`;
}

export const GOLDEN_TAG = {
  system: 'urn:fhir-integration-service:tags',
  code: 'golden-record',
  display: 'Computed from linked source records by survivorship rules',
};

export function presentGolden(master) {
  const { resourceType, id, ...rest } = master.golden;
  return {
    resourceType: resourceType ?? 'Patient',
    id: id ?? master.id,
    meta: { versionId: String(master.version_id), lastUpdated: master.updated_at.toISOString(), tag: [GOLDEN_TAG] },
    ...rest,
  };
}

const ISSUE_TYPE = {
  'missing-required': 'required',
  cardinality: 'structure',
  'invalid-code': 'code-invalid',
  'unknown-extension': 'extension',
  'unknown-element': 'structure',
  'invalid-value': 'value',
};

export function operationOutcome(severity, code, diagnostics, issues = []) {
  return {
    resourceType: 'OperationOutcome',
    issue: [
      ...(diagnostics ? [{ severity, code, diagnostics }] : []),
      ...issues.map((i) => ({
        severity: i.severity,
        code: ISSUE_TYPE[i.category] ?? 'processing',
        diagnostics: i.message,
        expression: [i.path],
      })),
    ],
  };
}

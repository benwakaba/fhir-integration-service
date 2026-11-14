// Shared test setup: a clean, migrated and seeded database per test, the app on
// an ephemeral port, and a mock FHIR source server that paginates like HAPI
// (opaque _getpages cursors on the server base) and can inject failures.

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { createApp } from '../src/app.js';
import pool from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

let migrated = false;

export async function resetDb() {
  if (!migrated) {
    await migrate(pool);
    migrated = true;
  }
  await pool.query(`TRUNCATE sources, ingest_runs, resources, resource_versions, sync_cursors, validation_issues,
    code_systems, codes, master_patients, master_patient_versions, patient_links, dismissed_pairs RESTART IDENTITY CASCADE`);
  await seed(pool);
}

export async function startApp() {
  const server = createApp().listen(0);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

/** fetch against the app with JSON in and out. */
export async function call(base, method, path, { body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/fhir+json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

/**
 * A FHIR server double. `resources` is mutable between requests (to simulate the
 * source changing); `faults` is a queue of { status, headers } answered before
 * real responses (to simulate throttling / outages).
 */
export async function mockFhirServer({ resources = [], pageSize = 2 } = {}) {
  const state = { resources, faults: [], requests: [] };
  const searches = new Map();
  const app = express();

  const page = (req, res, token, offset) => {
    const search = searches.get(token);
    if (!search) return res.status(410).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics: 'Search expired' }] });
    const slice = search.items.slice(offset, offset + search.count);
    const next = offset + search.count < search.items.length ? `${base}?_getpages=${token}&_getpagesoffset=${offset + search.count}&_count=${search.count}` : null;
    res.json({
      resourceType: 'Bundle',
      type: 'searchset',
      link: [{ relation: 'self', url: `${base}${req.originalUrl}` }, ...(next ? [{ relation: 'next', url: next }] : [])],
      entry: slice.map((resource) => ({ fullUrl: `${base}/${resource.resourceType}/${resource.id}`, resource, search: { mode: 'match' } })),
    });
  };

  app.use((req, res, next) => {
    state.requests.push(req.originalUrl);
    const fault = state.faults.shift();
    if (!fault) return next();
    res.status(fault.status).set(fault.headers ?? {}).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'transient' }] });
  });
  app.get('/', (req, res) => page(req, res, req.query._getpages, Number(req.query._getpagesoffset ?? 0)));
  app.get('/:type', (req, res) => {
    let items = state.resources.filter((r) => r.resourceType === req.params.type);
    if (req.query.patient) items = items.filter((r) => r.subject?.reference === `Patient/${req.query.patient}`);
    if (typeof req.query._lastUpdated === 'string' && req.query._lastUpdated.startsWith('ge')) {
      const from = Date.parse(req.query._lastUpdated.slice(2));
      items = items.filter((r) => Date.parse(r.meta?.lastUpdated ?? 0) >= from);
    }
    if (req.query._sort === '_lastUpdated') items = [...items].sort((a, b) => Date.parse(a.meta.lastUpdated) - Date.parse(b.meta.lastUpdated));
    const token = randomUUID();
    searches.set(token, { items, count: Number(req.query._count ?? pageSize) > pageSize ? pageSize : Number(req.query._count ?? pageSize) });
    page(req, res, token, 0);
  });

  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((r) => server.close(r)) };
}

/** Point a seeded pull source at a mock server. */
export async function useMockSource(sourceId, base) {
  await pool.query('UPDATE sources SET base_url = $2 WHERE id = $1', [sourceId, base]);
  const { rows } = await pool.query('SELECT * FROM sources WHERE id = $1', [sourceId]);
  return rows[0];
}

// --- fixture builders --------------------------------------------------------

export function patient(id, overrides = {}) {
  return {
    resourceType: 'Patient',
    id,
    meta: { versionId: '1', lastUpdated: '2024-01-01T00:00:00Z' },
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-12-3456' }],
    name: [{ use: 'official', family: 'Rivera', given: ['Ana'] }],
    gender: 'female',
    birthDate: '1970-05-17',
    ...overrides,
  };
}

export function observation(id, patientId, { code = '4548-4', system = 'http://loinc.org', value = 6.1, unit = '%', when = '2024-03-01T10:00:00Z', ...extra } = {}) {
  return {
    resourceType: 'Observation',
    id,
    meta: { versionId: '1', lastUpdated: '2024-03-02T00:00:00Z' },
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
    code: { coding: [{ system, code }] },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: when,
    ...(value !== null && { valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit } }),
    ...extra,
  };
}

export function condition(id, patientId, { code = 'E11.9', system = 'http://hl7.org/fhir/sid/icd-10-cm', onset = '2023-06-01', ...extra } = {}) {
  return {
    resourceType: 'Condition',
    id,
    meta: { versionId: '1', lastUpdated: '2024-01-05T00:00:00Z' },
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
    code: { coding: [{ system, code }] },
    subject: { reference: `Patient/${patientId}` },
    onsetDateTime: onset,
    ...extra,
  };
}

export { pool };

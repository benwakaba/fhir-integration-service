import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createFhirClient } from '../src/fhir/client.js';
import { entriesOf, paginate } from '../src/fhir/paginate.js';
import { ingestPatients, syncType } from '../src/ingest/runner.js';
import { mockFhirServer, observation, patient, pool, resetDb, useMockSource } from './helpers.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe('pagination', () => {
  let mock;
  before(async () => {
    mock = await mockFhirServer({ pageSize: 2, resources: [1, 2, 3, 4, 5].map((i) => observation(`o${i}`, 'p1')) });
  });
  after(() => mock.close());

  test('follows Bundle.link[next] verbatim until there is none', async () => {
    const client = createFhirClient({ baseUrl: mock.base, baseDelayMs: 1 });
    const ids = [];
    let pages = 0;
    for await (const { bundle } of paginate(client, client.searchUrl('Observation', { _count: 2 }))) {
      pages++;
      ids.push(...entriesOf(bundle).resources.map((r) => r.id));
    }
    assert.equal(pages, 3);
    assert.deepEqual(ids, ['o1', 'o2', 'o3', 'o4', 'o5']);
    assert.ok(mock.state.requests.slice(-2).every((url) => url.startsWith('/?_getpages='))); // opaque cursor, not an offset we built
  });

  test('retries throttling and outages, honoring Retry-After', async () => {
    mock.state.faults.push({ status: 429, headers: { 'retry-after': '0' } }, { status: 503 });
    const client = createFhirClient({ baseUrl: mock.base, baseDelayMs: 1, log: quiet });
    let count = 0;
    for await (const { bundle } of paginate(client, client.searchUrl('Observation'))) count += entriesOf(bundle).resources.length;
    assert.equal(count, 5);
  });

  test('gives up after bounded retries', async () => {
    mock.state.faults.push(...Array(5).fill({ status: 503 }));
    const client = createFhirClient({ baseUrl: mock.base, baseDelayMs: 1, maxRetries: 2, log: quiet });
    await assert.rejects(client.getJson(client.searchUrl('Observation')), /503/);
    mock.state.faults.length = 0;
  });

  test('detects a server that repeats its next link', async () => {
    const looping = { getJson: async (url) => ({ resourceType: 'Bundle', link: [{ relation: 'next', url }] }) };
    await assert.rejects(async () => {
      for await (const _ of paginate(looping, 'http://x/Observation')); // eslint-disable-line no-empty
    }, /Pagination loop/);
  });
});

describe('pull ingest', () => {
  let mock;
  let source;
  beforeEach(async () => {
    await resetDb();
    mock = await mockFhirServer({
      pageSize: 2,
      resources: [
        patient('p1'),
        patient('p2', { identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-45-6789' }], name: [{ family: 'Okafor', given: ['Chidi'] }], gender: 'male', birthDate: '1985-02-03' }),
        observation('o1', 'p1'),
        observation('o2', 'p1', { when: '2024-06-01T10:00:00Z', value: 6.4 }),
        observation('o3', 'p2', { code: '2345-7', value: 101, unit: 'mg/dL' }),
      ],
    });
    source = await useMockSource('smart', mock.base);
  });
  afterEach(() => mock.close());
  after(() => pool.end());

  test('stores patients and their compartments; re-running changes nothing', async () => {
    const first = await ingestPatients(source, { patients: 10, types: ['Observation'], log: quiet });
    assert.deepEqual([first.status, first.created, first.updated], ['completed', 5, 0]);
    const second = await ingestPatients(source, { patients: 10, types: ['Observation'], log: quiet });
    assert.deepEqual([second.created, second.updated, second.unchanged], [0, 0, 5]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM resource_versions');
    assert.equal(rows[0].n, 5);
  });

  test('a changed source resource gets a new version; the old one stays in history', async () => {
    await ingestPatients(source, { patients: 10, types: ['Observation'], log: quiet });
    const o1 = mock.state.resources.find((r) => r.id === 'o1');
    o1.valueQuantity.value = 6.9;
    o1.meta = { versionId: '2', lastUpdated: '2024-03-05T00:00:00Z' };
    const run = await ingestPatients(source, { patients: 10, types: ['Observation'], log: quiet });
    assert.equal(run.updated, 1);
    const { rows } = await pool.query(
      `SELECT v.version_id, v.source_version_id, v.resource->'valueQuantity'->>'value' AS value
       FROM resource_versions v JOIN resources r ON r.id = v.resource_id WHERE r.fhir_id = 'o1' ORDER BY v.version_id`,
    );
    assert.deepEqual(rows.map((r) => [r.version_id, r.source_version_id, r.value]), [[1, '1', '6.1'], [2, '2', '6.9']]);
  });

  test('a version bump with identical content mints no version', async () => {
    await ingestPatients(source, { patients: 10, types: ['Observation'], log: quiet });
    mock.state.resources.find((r) => r.id === 'o1').meta = { versionId: '9', lastUpdated: '2024-09-09T00:00:00Z' };
    const run = await ingestPatients(source, { patients: 10, types: ['Observation'], log: quiet });
    assert.equal(run.updated, 0);
    const { rows } = await pool.query(`SELECT version_id, source_version_id FROM resources WHERE fhir_id = 'o1'`);
    assert.deepEqual([rows[0].version_id, rows[0].source_version_id], [1, '9']);
  });

  test('incremental sync reads from the _lastUpdated high-water mark', async () => {
    await syncType(source, { type: 'Observation', log: quiet });
    const { rows } = await pool.query(`SELECT last_updated FROM sync_cursors WHERE source_id = 'smart' AND resource_type = 'Observation'`);
    assert.equal(rows[0].last_updated.toISOString(), '2024-03-02T00:00:00.000Z');
    mock.state.requests.length = 0;
    await syncType(source, { type: 'Observation', log: quiet });
    assert.match(decodeURIComponent(mock.state.requests[0]), /_lastUpdated=ge2024-03-02T00:00:00.000Z/);
  });

  test('validation issues are recorded against the version that has them', async () => {
    const bad = observation('bad', 'p1', { code: '4548-5' });
    delete bad.status;
    mock.state.resources.push(bad);
    const run = await ingestPatients(source, { patients: 10, types: ['Observation'], log: quiet });
    assert.equal(run.with_errors, 1);
    const { rows } = await pool.query(
      `SELECT vi.rule FROM validation_issues vi JOIN resources r ON r.id = vi.resource_id WHERE r.fhir_id = 'bad' ORDER BY vi.rule`,
    );
    assert.deepEqual(rows.map((r) => r.rule), ['loinc-check-digit', 'required-element']);
  });
});

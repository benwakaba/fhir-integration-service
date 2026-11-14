import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { call, observation, patient, pool, resetDb, startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await pool.end();
});

const transaction = (entries, type = 'transaction') => ({ resourceType: 'Bundle', type, entry: entries });
const put = (resource, ifMatch) => ({ resource, request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}`, ...(ifMatch && { ifMatch }) } });

describe('version-aware REST (ETag / If-Match)', () => {
  const url = '/fhir/clinic-b/Observation/o1';
  beforeEach(async () => {
    await resetDb();
    const created = await call(app.url, 'PUT', url, { body: observation('o1', 'p1') }); // push source: update-as-create
    assert.equal(created.status, 201);
  });

  test('reads carry ETag, Last-Modified and our versionId; If-None-Match gives 304', async () => {
    const read = await call(app.url, 'GET', url);
    assert.equal(read.headers.get('etag'), 'W/"1"');
    assert.ok(read.headers.get('last-modified'));
    assert.equal(read.body.meta.versionId, '1');
    const conditional = await fetch(`${app.url}${url}`, { headers: { 'If-None-Match': 'W/"1"' } });
    assert.equal(conditional.status, 304);
  });

  test('update without If-Match is 428; with the current version 200; with a stale one 412', async () => {
    const edit = { ...observation('o1', 'p1'), note: [{ text: 'corrected' }] };
    assert.equal((await call(app.url, 'PUT', url, { body: edit })).status, 428);
    const ok = await call(app.url, 'PUT', url, { body: edit, headers: { 'If-Match': 'W/"1"' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('etag'), 'W/"2"');
    const stale = await call(app.url, 'PUT', url, { body: edit, headers: { 'If-Match': 'W/"1"' } });
    assert.equal(stale.status, 412);
    assert.equal(stale.body.resourceType, 'OperationOutcome');
  });

  test('two concurrent updates from the same version: exactly one wins', async () => {
    const edit = (text) => call(app.url, 'PUT', url, { body: { ...observation('o1', 'p1'), note: [{ text }] }, headers: { 'If-Match': 'W/"1"' } });
    const results = await Promise.all([edit('a'), edit('b'), edit('c')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 412, 412]);
    const history = await call(app.url, 'GET', `${url}/_history`);
    assert.equal(history.body.total, 2);
  });

  test('history keeps every version; vread returns old ones', async () => {
    await call(app.url, 'PUT', url, { body: { ...observation('o1', 'p1'), status: 'amended' }, headers: { 'If-Match': 'W/"1"' } });
    const history = await call(app.url, 'GET', `${url}/_history`);
    assert.deepEqual(history.body.entry.map((e) => e.resource.status), ['amended', 'final']);
    const v1 = await call(app.url, 'GET', `${url}/_history/1`);
    assert.equal(v1.body.status, 'final');
    assert.equal(v1.headers.get('etag'), 'W/"1"');
  });

  test('delete needs If-Match, is soft, and reads then answer 410', async () => {
    assert.equal((await call(app.url, 'DELETE', url)).status, 428);
    const deleted = await call(app.url, 'DELETE', url, { headers: { 'If-Match': 'W/"1"' } });
    assert.equal(deleted.status, 204);
    assert.equal(deleted.headers.get('etag'), 'W/"2"');
    assert.equal((await call(app.url, 'GET', url)).status, 410);
    assert.equal((await call(app.url, 'GET', `${url}/_history`)).body.total, 2);
  });

  test('writes through the API must be valid R4 (422); pull sources cannot be created into', async () => {
    const invalid = await call(app.url, 'PUT', url, { body: { ...observation('o1', 'p1'), status: 'done' }, headers: { 'If-Match': 'W/"1"' } });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.body.issue.some((i) => i.expression?.[0] === 'Observation.status'));
    const create = await call(app.url, 'PUT', '/fhir/smart/Observation/new', { body: observation('new', 'p1') });
    assert.equal(create.status, 404);
  });
});

describe('push bundles', () => {
  beforeEach(resetDb);

  test('a transaction resolves urn:uuid references and is idempotent on resend', async () => {
    const bundle = transaction([
      { fullUrl: 'urn:uuid:9f0c1d2e-0000-4000-8000-000000000001', resource: patient(undefined), request: { method: 'POST', url: 'Patient' } },
      { fullUrl: 'urn:uuid:9f0c1d2e-0000-4000-8000-000000000002', resource: { ...observation(undefined, 'x'), subject: { reference: 'urn:uuid:9f0c1d2e-0000-4000-8000-000000000001' } }, request: { method: 'POST', url: 'Observation' } },
    ]);
    const first = await call(app.url, 'POST', '/fhir/clinic-b', { body: bundle });
    assert.equal(first.body.type, 'transaction-response');
    assert.deepEqual(first.body.entry.map((e) => e.response.status), ['201 Created', '201 Created']);
    const obs = await call(app.url, 'GET', '/fhir/clinic-b/Observation/9f0c1d2e-0000-4000-8000-000000000002');
    assert.equal(obs.body.subject.reference, 'Patient/9f0c1d2e-0000-4000-8000-000000000001');
    const again = await call(app.url, 'POST', '/fhir/clinic-b', { body: bundle });
    assert.deepEqual(again.body.entry.map((e) => e.response.status), ['200 OK', '200 OK']);
    assert.equal(again.body.entry[0].response.etag, 'W/"1"');
  });

  test('a stale ifMatch aborts the whole transaction', async () => {
    await call(app.url, 'POST', '/fhir/clinic-b', { body: transaction([put(patient('p1')), put(observation('o1', 'p1'))]) });
    const res = await call(app.url, 'POST', '/fhir/clinic-b', {
      body: transaction([put(patient('p1', { gender: 'male' }), 'W/"1"'), put(observation('o1', 'p1', { value: 9.9 }), 'W/"7"')]),
    });
    assert.equal(res.status, 412);
    assert.match(res.body.issue[0].diagnostics, /Bundle.entry\[1\]/);
    const p1 = await call(app.url, 'GET', '/fhir/clinic-b/Patient/p1');
    assert.equal(p1.body.gender, 'female'); // entry 0 rolled back with entry 1
  });

  test('batch entries fail independently', async () => {
    const res = await call(app.url, 'POST', '/fhir/clinic-b', {
      body: transaction([put(patient('p1')), { request: { method: 'GET', url: 'Patient/p1' } }, put(observation('o1', 'p1'))], 'batch'),
    });
    assert.deepEqual(res.body.entry.map((e) => e.response.status), ['201 Created', '400 Bad Request', '201 Created']);
  });

  test('pushed data is stored even when invalid, with the issues in the response', async () => {
    const res = await call(app.url, 'POST', '/fhir/clinic-b', { body: transaction([put(patient('p1', { gender: 'M' }))]) });
    assert.equal(res.body.entry[0].response.status, '201 Created');
    assert.ok(res.body.entry[0].response.outcome.issue.some((i) => i.expression[0] === 'Patient.gender'));
  });
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { call, condition, observation, patient, pool, resetDb, startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(resetDb);

const put = (resource) => ({ resource, request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` } });
const push = (source, resources) =>
  call(app.url, 'POST', `/fhir/${source}`, { body: { resourceType: 'Bundle', type: 'transaction', entry: resources.map(put) } });
const masters = async () => (await call(app.url, 'GET', '/patients')).body.patients;

describe('matching', () => {
  test('the same SSN in different spellings links two sources to one patient', async () => {
    await push('clinic-b', [patient('a1', { meta: { lastUpdated: '2024-01-01T00:00:00Z' } })]);
    await push('smart', [patient('s9', { identifier: [{ system: 'urn:oid:2.16.840.1.113883.4.1', value: '999123456' }] })]);
    const [only, ...rest] = await masters();
    assert.equal(rest.length, 0);
    const detail = await call(app.url, 'GET', `/patients/${only.id}`);
    assert.deepEqual(detail.body.links.map((l) => [l.source, l.method]).sort(), [['clinic-b', 'new'], ['smart', 'identifier']]);
  });

  // No trusted identifier anywhere below: only names, a birthDate and a postal code.
  const bare = { identifier: undefined, address: [{ postalCode: '02110' }] };
  const typo = { ...bare, name: [{ family: 'Riviera', given: ['Ana'] }] }; // one letter off "Rivera"
  const bySource = (list, source) => list.find((m) => m.sources.includes(source));
  const detail = (id) => call(app.url, 'GET', `/patients/${id}`);

  test('name and birthDate alone never link: similar records are flagged for a steward', async () => {
    await push('clinic-b', [patient('a1', bare)]);
    await push('smart', [patient('s1', typo)]); // same birthDate and postal code
    await push('hapi', [patient('h1', { ...bare, name: [{ family: 'Chen', given: ['Mei'] }] })]); // same birthDate only
    const list = await masters();
    assert.deepEqual(list.map((m) => m.records), [1, 1, 1]); // nobody was merged
    assert.deepEqual(list.filter((m) => m.needsReview).map((m) => m.name).sort(), ['Ana Rivera', 'Ana Riviera']);
    const { body } = await detail(bySource(list, 'smart').id);
    assert.equal(body.possibleDuplicates.length, 1);
    assert.equal(body.possibleDuplicates[0].masterId, bySource(list, 'clinic-b').id);
    assert.match(body.possibleDuplicates[0].reason, /name and birthDate agree \(score 0\.85\) with no identifier in common/);
    assert.deepEqual(body.links.map((l) => l.method), ['new']);
  });

  // An MRN means something only inside the namespace that issued it.
  const mrn = (value, system = 'http://hospital.example/mrn') => ({ identifier: [{ system, type: { coding: [{ code: 'MR' }] }, value }] });

  test('the same MRN in the same namespace links when name and birthDate agree as well', async () => {
    await push('clinic-b', [patient('a1', mrn('MRN-00417'))]);
    await push('smart', [patient('s1', mrn('MRN-00417'))]); // the record, seen again
    const list = await masters();
    assert.deepEqual(list.map((m) => [m.records, m.needsReview]), [[2, false]]);
    const { body } = await detail(list[0].id);
    assert.deepEqual(body.links.map((l) => [l.source, l.method]).sort(), [['clinic-b', 'new'], ['smart', 'identifier+demographics']]);
  });

  test('a shared MRN alone is not identity: another name is a question, another birthDate is another person', async () => {
    await push('clinic-b', [patient('a1', mrn('MRN-00417'))]);
    await push('smart', [patient('s1', { ...mrn('MRN-00417'), name: [{ family: 'Okafor', given: ['Ana'] }] })]); // same birthDate, new family name
    await push('hapi', [patient('h1', { ...mrn('MRN-00417'), birthDate: '1982-11-03' })]); // same name, another birthDate
    const list = await masters();
    assert.deepEqual(list.map((m) => m.records), [1, 1, 1]); // nobody merged
    assert.deepEqual(list.filter((m) => m.needsReview).map((m) => m.name).sort(), ['Ana Okafor', 'Ana Rivera']);
    const { body } = await detail(bySource(list, 'smart').id);
    assert.match(body.possibleDuplicates[0].reason, /shares http:\/\/hospital\.example\/mrn and birthDate but the name differs/);
    assert.equal((await detail(bySource(list, 'hapi').id)).body.possibleDuplicates.length, 0);
  });

  test('the same MRN under another namespace, or a throwaway value, is not evidence', async () => {
    await push('clinic-b', [patient('a1', mrn('MRN-00417'))]);
    await push('smart', [patient('s1', mrn('MRN-00417', 'http://other-hospital.example/mrn'))]);
    await push('hapi', [patient('h1', mrn('12345'))]);
    await push('hapi', [patient('h2', mrn('12345'))]); // the MRN on every example patient
    const list = await masters();
    assert.equal(list.length, 4); // nobody merged...
    assert.ok(list.every((m) => m.needsReview && m.possibleDuplicates === 3)); // ...but all four look alike, so a steward decides
  });

  test('two different SSNs on look-alike records are called out to the steward', async () => {
    const ssn = (value) => ({ identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value }] });
    await push('clinic-b', [patient('a1', ssn('999-12-3456'))]);
    await push('smart', [patient('s1', ssn('999-65-4321'))]); // same name and birthDate, another SSN
    const list = await masters();
    assert.equal(list.length, 2);
    const { body } = await detail(list[0].id);
    assert.match(body.possibleDuplicates[0].reason, /us-ssn differs/);
  });

  test('a steward confirms a candidate by linking it, which settles the flag on both sides', async () => {
    await push('clinic-b', [patient('a1', bare)]);
    await push('smart', [patient('s1', typo)]);
    const target = bySource(await masters(), 'clinic-b');
    const before = await detail(target.id);
    const res = await call(app.url, 'POST', `/patients/${target.id}/link`, {
      body: { source: 'smart', fhirId: 's1' },
      headers: { 'If-Match': before.headers.get('etag') },
    });
    assert.equal(res.status, 200);
    const list = await masters();
    assert.deepEqual(list.map((m) => [m.records, m.needsReview, m.possibleDuplicates]), [[2, false, 0]]);
    const after = await detail(target.id);
    assert.deepEqual(after.body.links.map((l) => [l.source, l.method]).sort(), [['clinic-b', 'new'], ['smart', 'manual']]);
  });

  test('dismissing one candidate keeps the others open and moves the ETag', async () => {
    await push('clinic-b', [patient('a1', bare)]);
    await push('smart', [patient('s1', typo)]);
    await push('hapi', [patient('h1', bare)]); // resembles both
    const list = await masters();
    const [a, s] = [bySource(list, 'clinic-b'), bySource(list, 'smart')];
    const before = await detail(a.id);
    assert.equal(before.body.possibleDuplicates.length, 2);
    const etag = before.headers.get('etag');

    const one = await call(app.url, 'POST', `/patients/${a.id}/dismiss-duplicates`, { body: { patient: s.id }, headers: { 'If-Match': etag } });
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.needsReview, one.body.possibleDuplicates.length], [true, 1]);
    assert.notEqual(one.headers.get('etag'), etag); // a steward acting on the old view must be told
    const stale = await call(app.url, 'POST', `/patients/${a.id}/dismiss-duplicates`, { headers: { 'If-Match': etag } });
    assert.equal(stale.status, 412);
    const notFlagged = await call(app.url, 'POST', `/patients/${a.id}/dismiss-duplicates`, { body: { patient: s.id }, headers: { 'If-Match': one.headers.get('etag') } });
    assert.equal(notFlagged.status, 400);
    assert.equal((await detail(s.id)).body.possibleDuplicates.length, 1); // s is still flagged with the hapi record
  });

  test('when a merge empties a patient, its open candidates follow the merged record', async () => {
    await push('clinic-b', [patient('a1', bare)]);
    await push('smart', [patient('s1', typo)]);
    await push('hapi', [patient('h1', bare)]);
    const list = await masters();
    const [a, s, h] = [bySource(list, 'clinic-b'), bySource(list, 'smart'), bySource(list, 'hapi')];
    const before = await detail(a.id);
    await call(app.url, 'POST', `/patients/${a.id}/link`, { body: { source: 'smart', fhirId: 's1' }, headers: { 'If-Match': before.headers.get('etag') } });
    const remaining = (await detail(h.id)).body.possibleDuplicates;
    assert.deepEqual(remaining.map((d) => d.masterId), [a.id]); // nothing still points at the emptied record
    assert.equal((await masters()).some((m) => m.id === s.id), false);
  });

  test('a shared identifier with a contradicting birthDate is flagged, not merged', async () => {
    await push('clinic-b', [patient('a1')]);
    await push('smart', [patient('s1', { name: [{ family: 'Monsivais', given: ['Ana'] }], birthDate: '1990-10-10' })]); // same SSN
    const list = await masters();
    assert.equal(list.length, 2);
    assert.ok(list.every((m) => m.needsReview));
    const other = list.find((m) => m.name === 'Ana Monsivais');
    const detail = await call(app.url, 'GET', `/patients/${other.id}`);
    assert.match(detail.body.possibleDuplicates[0].reason, /us-ssn but birthDate differs/);
    const dismissed = await call(app.url, 'POST', `/patients/${other.id}/dismiss-duplicates`, { headers: { 'If-Match': detail.headers.get('etag') } });
    assert.equal(dismissed.body.needsReview, false);
    assert.ok((await masters()).every((m) => !m.needsReview));
  });

  test('malformed SSNs and unrendered templates are not trusted', async () => {
    await push('clinic-b', [patient('a1', { identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '56TYRU' }] })]);
    await push('smart', [patient('s1', { identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '56TYRU' }], name: [{ family: 'Carballo', given: ['Lidia'] }], birthDate: '1980-10-10' })]);
    assert.equal((await masters()).length, 2);
  });

  test('a placeholder SSN never links two people', async () => {
    const placeholder = { identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-99-9999' }] };
    await push('clinic-b', [patient('a1', placeholder)]);
    await push('smart', [patient('s1', { ...placeholder, name: [{ family: 'Okafor', given: ['Chidi'] }], gender: 'male', birthDate: '1990-01-01' })]);
    assert.equal((await masters()).length, 2);
  });
});

describe('reconciliation', () => {
  const clinicB = (overrides = {}) =>
    patient('b1', {
      meta: { lastUpdated: '2025-06-01T00:00:00Z' },
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999123456' }],
      telecom: [{ system: 'phone', value: '555-999-0000', use: 'home' }],
      address: [{ line: ['9 New St'], city: 'Cambridge', postalCode: '02139' }],
      ...overrides,
    });

  async function linkedPair() {
    await push('smart', [patient('s1', { meta: { lastUpdated: '2021-01-01T00:00:00Z' }, telecom: [{ system: 'phone', value: '555-111-2222', use: 'home' }], address: [{ line: ['1 Old Rd'], city: 'Boston', postalCode: '02110' }] })]);
    await push('clinic-b', [clinicB()]);
    return (await masters())[0].id;
  }

  test('conflicts are recorded and the golden record follows the documented policy', async () => {
    const id = await linkedPair();
    const { body } = await call(app.url, 'GET', `/patients/${id}`);
    assert.deepEqual(body.golden.address.map((a) => [a.line[0], a.use]), [['9 New St', undefined], ['1 Old Rd', 'old']]);
    assert.equal(body.golden.telecom.length, 2);
    assert.deepEqual(body.conflicts.map((c) => c.element).sort(), ['address', 'telecom:phone:home']);
    assert.equal(body.needsReview, false);
    assert.ok(body.golden.link.every((l) => l.type === 'seealso'));
  });

  test('a linked record whose birthDate later diverges needs review until a steward override resolves it', async () => {
    const id = await linkedPair();
    await push('clinic-b', [clinicB({ birthDate: '1971-05-17', meta: { lastUpdated: '2025-07-01T00:00:00Z' } })]); // links are sticky
    const before = await call(app.url, 'GET', `/patients/${id}`);
    assert.equal(before.body.needsReview, true);
    const etag = before.headers.get('etag');

    assert.equal((await call(app.url, 'PUT', `/patients/${id}/overrides`, { body: { birthDate: '1970-05-17' } })).status, 428);
    const ok = await call(app.url, 'PUT', `/patients/${id}/overrides`, { body: { birthDate: '1970-05-17' }, headers: { 'If-Match': etag } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.needsReview, false);
    assert.equal(ok.body.golden.birthDate, '1970-05-17');
    const stale = await call(app.url, 'PUT', `/patients/${id}/overrides`, { body: { birthDate: '1971-05-17' }, headers: { 'If-Match': etag } });
    assert.equal(stale.status, 412);
    const invalid = await call(app.url, 'PUT', `/patients/${id}/overrides`, { body: { gender: 'F' }, headers: { 'If-Match': ok.headers.get('etag') } });
    assert.equal(invalid.status, 422);
  });

  test('a wrong link can be undone, and every change is a golden-record version', async () => {
    const id = await linkedPair();
    const { headers } = await call(app.url, 'GET', `/patients/${id}`);
    const res = await call(app.url, 'POST', `/patients/${id}/unlink`, { body: { source: 'clinic-b', fhirId: 'b1' }, headers: { 'If-Match': headers.get('etag') } });
    assert.equal(res.status, 200);
    assert.equal((await masters()).length, 2);
    const history = await call(app.url, 'GET', `/patients/${id}/history`);
    assert.deepEqual(history.body.versions.map((v) => v.reason.split(' ')[0]), ['unlinked', 'linked', 'created']);
  });

  test('deleting a source record removes it from the golden record', async () => {
    const id = await linkedPair();
    await call(app.url, 'DELETE', '/fhir/clinic-b/Patient/b1', { headers: { 'If-Match': 'W/"1"' } });
    const { body } = await call(app.url, 'GET', `/patients/${id}`);
    assert.deepEqual(body.golden.address.map((a) => a.line[0]), ['1 Old Rd']);
    assert.equal(body.conflicts.length, 0);
  });

  test('$everything merges both sources, rewrites patient references and drops cross-source duplicates', async () => {
    const id = await linkedPair();
    const shared = { when: '2024-03-01T10:00:00Z', value: 6.1 };
    await push('smart', [observation('so1', 's1', shared), condition('sc1', 's1', { code: '44054006', system: 'http://snomed.info/sct' })]);
    await push('clinic-b', [observation('bo1', 'b1', shared), observation('bo2', 'b1', { when: '2025-01-01T10:00:00Z', value: 7.2 })]);
    const { body } = await call(app.url, 'GET', `/patients/${id}/$everything`);
    const resources = body.entry.map((e) => e.resource);
    assert.equal(resources[0].meta.tag[0].code, 'golden-record');
    const observations = resources.filter((r) => r.resourceType === 'Observation');
    assert.equal(observations.length, 2);
    assert.ok(observations.every((o) => o.subject.reference === `http://fhir.test/fhir/golden/Patient/${id}`));
    const outcome = resources.at(-1);
    assert.equal(outcome.resourceType, 'OperationOutcome');
    assert.ok(outcome.issue.some((i) => i.code === 'duplicate' && /1 cross-source duplicate/.test(i.diagnostics)));
    assert.ok(outcome.issue.some((i) => i.code === 'conflict'));
  });
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { call, patient, pool, resetDb, startApp } from './helpers.js';

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

// Look-alikes with no identifier anywhere: only a name, a birthDate and a postal code.
const bare = { identifier: undefined, address: [{ postalCode: '02110' }] };
const rivera = (id) => patient(id, bare); // Ana Rivera
const riviera = (id) => patient(id, { ...bare, name: [{ family: 'Riviera', given: ['Ana'] }] }); // a letter off
const anna = (id) => patient(id, { ...bare, name: [{ family: 'Rivera', given: ['Anna'] }] }); // resembles Rivera, not Riviera
const chen = (id) => patient(id, { ...bare, name: [{ family: 'Chen', given: ['Mei'] }], birthDate: '1980-01-01' });

const masterOf = async (sourceId, fhirId) =>
  (
    await pool.query(
      `SELECT pl.master_id AS id FROM patient_links pl JOIN resources r ON r.id = pl.resource_id WHERE r.source_id = $1 AND r.fhir_id = $2`,
      [sourceId, fhirId],
    )
  ).rows[0].id;
const groups = async (query = '') => (await call(app.url, 'GET', `/patients/duplicate-groups${query}`)).body;
const group = (id) => call(app.url, 'GET', `/patients/duplicate-groups/${id}`);
const confirm = (id, etag, body) =>
  call(app.url, 'POST', `/patients/duplicate-groups/${id}/confirm`, { body, headers: etag === undefined ? {} : { 'If-Match': etag } });
const dismiss = (id, etag, body) =>
  call(app.url, 'POST', `/patients/duplicate-groups/${id}/dismiss`, { body, headers: etag === undefined ? {} : { 'If-Match': etag } });
const patients = async () => (await call(app.url, 'GET', '/patients')).body.patients;

/** Ana Rivera x2 and Ana Riviera, from three sources: every pair resembles each other. */
async function threeLookAlikes() {
  await push('clinic-b', [rivera('a1')]);
  await push('smart', [riviera('s1')]);
  await push('hapi', [rivera('h1')]);
  return { a: await masterOf('clinic-b', 'a1'), s: await masterOf('smart', 's1'), h: await masterOf('hapi', 'h1') };
}

/** The same plus Anna Rivera, who resembles Rivera but not Riviera: a group that is not complete. */
async function fourWithAChain() {
  const ids = await threeLookAlikes();
  await push('smart', [anna('d1')]);
  return { ...ids, d: await masterOf('smart', 'd1') };
}

describe('listing groups', () => {
  test('look-alikes form one group, oldest first, with an ETag that covers every member', async () => {
    const { a, s, h } = await threeLookAlikes();
    const { total, groups: list } = await groups();
    assert.equal(total, 1);
    const [g] = list;
    assert.deepEqual([g.size, g.records, g.complete, g.survivor, g.minScore], [3, 3, true, a, 0.85]);
    assert.deepEqual(g.patients.map((p) => p.id), [a, s, h]);
    assert.deepEqual(g.reasons, [{ reason: 'name and birthDate agree (score N) with no identifier in common', pairs: 3 }]);
    const detail = await group(h); // any member finds the group
    assert.equal(detail.headers.get('etag'), g.etag);
    assert.equal(detail.body.size, 3);
  });

  test('a chain of look-alikes is one group but is not complete', async () => {
    await fourWithAChain();
    const [g] = (await groups()).groups;
    assert.deepEqual([g.size, g.complete], [4, false]);
  });

  test('groups come biggest first and can be narrowed to a source', async () => {
    await threeLookAlikes();
    await push('smart', [chen('c1'), chen('c2')]);
    const all = (await groups()).groups;
    assert.deepEqual(all.map((g) => g.records), [3, 2]);
    assert.deepEqual((await groups('?source=hapi')).groups.map((g) => g.records), [3]);
    assert.equal((await groups('?source=hapi')).total, 1);
  });

  test('a patient with no possible duplicates is not in a group', async () => {
    await push('smart', [chen('c1')]);
    const id = await masterOf('smart', 'c1');
    assert.equal((await group(id)).status, 404);
    assert.deepEqual((await groups()).groups, []);
  });
});

describe('confirming a group', () => {
  test('needs the ETag of the view that was read, and refuses a stale or malformed one', async () => {
    const { a } = await threeLookAlikes();
    const etag = (await group(a)).headers.get('etag');
    assert.equal((await confirm(a, undefined)).status, 428);
    assert.equal((await confirm(a, '"3"')).status, 400); // a patient ETag is not a group ETag
    await push('smart', [anna('d1')]); // the group changes under the steward
    const stale = await confirm(a, etag);
    assert.equal(stale.status, 412);
    assert.match(stale.body.error, /changed since it was read/);
    assert.equal((await groups()).groups[0].size, 4); // nothing was merged
  });

  test('merges everyone into the oldest patient and settles the flags', async () => {
    const { a, s, h } = await threeLookAlikes();
    const res = await confirm(a, (await group(a)).headers.get('etag'));
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.survivor, [...res.body.merged].sort(), res.body.records], [a, [s, h].sort(), 3]);
    assert.deepEqual([res.body.needsReview, res.body.remainingCandidates, res.body.overridesDropped], [false, [], []]);
    assert.equal(res.body.golden.id, a);
    assert.equal(res.headers.get('etag'), `W/"${res.body.version}"`);

    assert.deepEqual((await patients()).map((p) => [p.id, p.records, p.needsReview, p.possibleDuplicates]), [[a, 3, false, 0]]);
    assert.deepEqual((await groups()).groups, []);
    const detail = (await call(app.url, 'GET', `/patients/${a}`)).body;
    assert.deepEqual(detail.links.map((l) => [l.source, l.method]).sort(), [['clinic-b', 'new'], ['hapi', 'manual'], ['smart', 'manual']]);
    const history = (await call(app.url, 'GET', `/patients/${a}/history`)).body.versions;
    assert.match(history[0].reason, /^confirmed 3 patients as one person/);
  });

  test('merged-away ids redirect, read as tombstones, and refuse steward actions', async () => {
    const { a, s } = await threeLookAlikes();
    await confirm(a, (await group(a)).headers.get('etag'));

    const moved = await fetch(`${app.url}/patients/${s}/observations?concept=hba1c`, { redirect: 'manual' });
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), `/patients/${a}/observations?concept=hba1c`);
    assert.equal((await call(app.url, 'GET', `/patients/${s}`)).body.patient.id, a); // fetch follows the redirect

    const tombstone = await call(app.url, 'GET', `/fhir/golden/Patient/${s}`);
    assert.equal(tombstone.status, 200);
    assert.deepEqual([tombstone.body.active, tombstone.body.link[0].type], [false, 'replaced-by']);
    assert.match(tombstone.body.link[0].other.reference, new RegExp(`/fhir/golden/Patient/${a}$`));
    const history = await call(app.url, 'GET', `/patients/${s}/history`); // history stays with the id asked for
    assert.match(history.body.versions[0].reason, new RegExp(`^merged into ${a}`));

    const act = await call(app.url, 'POST', `/patients/${s}/dismiss-duplicates`, { headers: { 'If-Match': 'W/"1"' } });
    assert.equal(act.status, 409);
    assert.match(act.body.error, new RegExp(`merged into ${a}`));
  });

  test('a record can still be split back out afterwards, and remembers where it came from', async () => {
    const { a, h } = await threeLookAlikes();
    await confirm(a, (await group(a)).headers.get('etag'));
    const etag = (await call(app.url, 'GET', `/patients/${a}`)).headers.get('etag');
    const res = await call(app.url, 'POST', `/patients/${a}/unlink`, { body: { source: 'smart', fhirId: 's1' }, headers: { 'If-Match': etag } });
    assert.equal(res.status, 200);
    assert.equal((await patients()).length, 2);
    const { matched_on: matchedOn } = (await pool.query(`SELECT pl.matched_on FROM patient_links pl JOIN resources r ON r.id = pl.resource_id WHERE r.fhir_id = 'h1'`)).rows[0];
    assert.equal(matchedOn.mergedFrom, h);
  });

  test('a subset can be confirmed, leaving the rest flagged against the merged patient', async () => {
    const { a, s, h, d } = await fourWithAChain();
    const before = await group(a);
    assert.equal(before.body.complete, false);
    const dBefore = (await call(app.url, 'GET', `/patients/${d}`)).body;

    const res = await confirm(a, before.headers.get('etag'), { patients: [a, s, h] });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.survivor, res.body.needsReview, res.body.remainingCandidates], [a, true, [d]]);
    assert.equal(res.body.records, 3);

    const dAfter = (await call(app.url, 'GET', `/patients/${d}`)).body;
    assert.deepEqual(dAfter.possibleDuplicates.map((p) => p.masterId), [a]); // two flags became one
    assert.ok(dAfter.version > dBefore.version); // its ETag moved, so a stale view is caught
    const rest = await group(d);
    assert.deepEqual(rest.body.patients.map((p) => p.id).sort(), [a, d].sort());

    const dismissed = await call(app.url, 'POST', `/patients/${d}/dismiss-duplicates`, { body: { patient: a }, headers: { 'If-Match': `W/"${dAfter.version}"` } });
    assert.equal(dismissed.status, 200);
    assert.deepEqual((await groups()).groups, []);
    assert.deepEqual((await patients()).map((p) => p.needsReview), [false, false]);
  });

  test('the survivor can be chosen', async () => {
    const { a, s, h } = await threeLookAlikes();
    const res = await confirm(a, (await group(a)).headers.get('etag'), { survivor: h });
    assert.deepEqual([res.body.survivor, [...res.body.merged].sort()], [h, [a, s].sort()]);
    assert.equal((await call(app.url, 'GET', `/patients/${a}`)).body.patient.id, h); // the oldest now redirects
  });

  test('validates the selection', async () => {
    const { a, s } = await threeLookAlikes();
    const etag = (await group(a)).headers.get('etag');
    const stranger = '00000000-0000-4000-8000-000000000000';
    for (const [body, pattern] of [
      [{ patients: [a, stranger] }, /is not in this group/],
      [{ patients: [a] }, /at least two/],
      [{ patients: [a, s], survivor: stranger }, /must be one of the confirmed/],
      [{ patients: 'a' }, /array of patient ids/],
    ]) {
      const res = await confirm(a, etag, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, pattern);
    }
    assert.equal((await confirm(stranger, etag)).status, 404);
    assert.equal((await confirm('not-a-uuid', etag)).status, 404);
    assert.equal((await groups()).groups[0].size, 3); // nothing changed
  });

  test('two confirms of the same group at once: one wins, the other finds nothing left', async () => {
    const { a } = await threeLookAlikes();
    const etag = (await group(a)).headers.get('etag');
    const results = await Promise.all([confirm(a, etag), confirm(a, etag)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
    assert.equal((await patients()).length, 1);
    assert.equal((await call(app.url, 'GET', `/patients/${a}`)).body.links.length, 3); // no record lost or doubled
  });

  test('says when a merged-away patient had pinned values, which do not carry over', async () => {
    const { a, s } = await threeLookAlikes();
    const sEtag = (await call(app.url, 'GET', `/patients/${s}`)).headers.get('etag');
    const pinned = await call(app.url, 'PUT', `/patients/${s}/overrides`, { body: { maritalStatus: { text: 'Married' } }, headers: { 'If-Match': sEtag } });
    assert.equal(pinned.status, 200);
    const res = await confirm(a, (await group(a)).headers.get('etag')); // pinning changed s, so a fresh ETag
    assert.deepEqual(res.body.overridesDropped, [s]);
  });
});

describe('dismissing a group', () => {
  test('a whole group of different people loses every flag, and nothing merges', async () => {
    const { a, s, h } = await threeLookAlikes();
    const versionBefore = (await call(app.url, 'GET', `/patients/${s}`)).body.version;
    const res = await dismiss(a, (await group(a)).headers.get('etag'));
    assert.equal(res.status, 200);
    assert.deepEqual([[...res.body.dismissed].sort(), res.body.remaining, res.body.stillNeedReview], [[a, s, h].sort(), [], []]);
    assert.deepEqual((await patients()).map((p) => [p.records, p.needsReview, p.possibleDuplicates]), [[1, false, 0], [1, false, 0], [1, false, 0]]);
    assert.deepEqual((await groups()).groups, []);
    const after = (await call(app.url, 'GET', `/patients/${s}`)).body;
    assert.ok(after.version > versionBefore); // its ETag moved, so a stale view of it is caught
    const history = (await call(app.url, 'GET', `/patients/${s}/history`)).body.versions;
    assert.match(history[0].reason, /^dismissed as different from the other patients in a group of 3/);
  });

  test('needs the ETag of the view that was read, and refuses a stale or malformed one', async () => {
    const { a } = await threeLookAlikes();
    const etag = (await group(a)).headers.get('etag');
    assert.equal((await dismiss(a, undefined)).status, 428);
    assert.equal((await dismiss(a, '"3"')).status, 400);
    await push('smart', [anna('d1')]); // the group changes under the steward
    const stale = await dismiss(a, etag);
    assert.equal(stale.status, 412);
    assert.match(stale.body.error, /Read it again before dismissing/);
    assert.equal((await groups()).groups[0].size, 4); // nothing was dismissed
  });

  test('the odd one out can be dismissed, and what is left comes back ready to confirm', async () => {
    const { a, s, h, d } = await fourWithAChain();
    const res = await dismiss(a, (await group(a)).headers.get('etag'), { patients: [d] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.dismissed, [d]);
    assert.equal(res.body.remaining.length, 1);
    const [left] = res.body.remaining;
    assert.deepEqual([left.size, left.complete, left.patients.map((p) => p.id)], [3, true, [a, s, h]]); // without d, a clique
    assert.equal((await call(app.url, 'GET', `/patients/${d}`)).body.possibleDuplicates.length, 0);

    // The ETag in the response is current: the steward can confirm the rest without reading again.
    const merged = await confirm(a, left.etag);
    assert.equal(merged.status, 200);
    assert.deepEqual([merged.body.records, (await patients()).length, (await groups()).total], [3, 2, 0]);
  });

  test('dismissing the patients that link the rest leaves nothing flagged', async () => {
    const { a, s, h, d } = await fourWithAChain(); // s and d resemble a and h, but not each other
    const res = await dismiss(a, (await group(a)).headers.get('etag'), { patients: [a, h] });
    assert.deepEqual([[...res.body.dismissed].sort(), res.body.remaining], [[a, h].sort(), []]);
    for (const id of [a, s, h, d]) assert.equal((await call(app.url, 'GET', `/patients/${id}`)).body.possibleDuplicates.length, 0);
  });

  test('a dismissal sticks when a new look-alike arrives', async () => {
    const { a } = await threeLookAlikes();
    await dismiss(a, (await group(a)).headers.get('etag'));
    await push('smart', [rivera('x1')]); // resembles all three
    const x = await masterOf('smart', 'x1');
    const [g] = (await groups()).groups;
    assert.deepEqual([g.size, g.complete], [4, false]); // the newcomer is flagged against each; the three are not re-flagged against each other
    assert.deepEqual((await call(app.url, 'GET', `/patients/${a}`)).body.possibleDuplicates.map((p) => p.masterId), [x]);
  });

  test('validates the selection', async () => {
    const { a } = await threeLookAlikes();
    const etag = (await group(a)).headers.get('etag');
    const stranger = '00000000-0000-4000-8000-000000000000';
    for (const [body, pattern] of [
      [{ patients: [a, stranger] }, /is not in this group/],
      [{ patients: [] }, /at least one patient/],
      [{ patients: 'a' }, /array of patient ids/],
    ]) {
      const res = await dismiss(a, etag, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, pattern);
    }
    assert.equal((await dismiss(stranger, etag)).status, 404);
    assert.equal((await dismiss('not-a-uuid', etag)).status, 404);
    assert.equal((await groups()).groups[0].size, 3); // nothing changed
  });

  test('two dismissals of the same group at once: one wins, the other finds nothing left', async () => {
    const { a } = await threeLookAlikes();
    const etag = (await group(a)).headers.get('etag');
    const results = await Promise.all([dismiss(a, etag), dismiss(a, etag)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
    assert.deepEqual((await groups()).groups, []);
  });

  test('a dismissed patient can still need review for another reason', async () => {
    await push('clinic-b', [patient('b1')]);
    await push('smart', [patient('s1')]); // same SSN, name and birthDate: one person, two records
    await push('clinic-b', [patient('b1', { birthDate: '1971-05-17', meta: { lastUpdated: '2025-07-01T00:00:00Z' } })]); // now their birthDates disagree
    await push('hapi', [rivera('h1')]); // resembles the linked patient
    const m = await masterOf('clinic-b', 'b1');
    const h = await masterOf('hapi', 'h1');
    const [g] = (await groups()).groups;
    assert.deepEqual(g.patients.map((p) => p.id).sort(), [m, h].sort());

    const res = await dismiss(m, g.etag);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stillNeedReview, [m]); // no longer flagged against h, but its own records still conflict
    assert.deepEqual((await patients()).filter((p) => p.needsReview).map((p) => p.id), [m]);
    assert.deepEqual((await groups()).groups, []);
  });
});

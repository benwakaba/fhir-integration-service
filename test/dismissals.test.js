// Remembered dismissals: a steward's "these are different people" is stored against
// source records, so a rebuild (which regenerates every golden id) does not raise it
// again, and the latest steward decision wins.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { rebuildMpi } from '../src/mpi/rebuild.js';
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
const rivera = (id, extra = {}) => patient(id, { ...bare, ...extra }); // Ana Rivera
const riviera = (id, extra = {}) => patient(id, { ...bare, name: [{ family: 'Riviera', given: ['Ana'] }], ...extra }); // a letter off
const mrn = (value) => ({ identifier: [{ system: 'http://hospital.example/mrn', type: { coding: [{ code: 'MR' }] }, value }] });

const masterOf = async (sourceId, fhirId) =>
  (
    await pool.query(
      `SELECT pl.master_id AS id FROM patient_links pl JOIN resources r ON r.id = pl.resource_id WHERE r.source_id = $1 AND r.fhir_id = $2`,
      [sourceId, fhirId],
    )
  ).rows[0].id;
const detail = (id) => call(app.url, 'GET', `/patients/${id}`);
const flagsOn = async (id) => (await detail(id)).body.possibleDuplicates.map((d) => d.masterId).sort();
const groups = async () => (await call(app.url, 'GET', '/patients/duplicate-groups')).body;
const group = (id) => call(app.url, 'GET', `/patients/duplicate-groups/${id}`);

// Group actions read the group first, as a steward would, and send its ETag back.
const onGroup = async (verb, id, body) =>
  call(app.url, 'POST', `/patients/duplicate-groups/${id}/${verb}`, { body, headers: { 'If-Match': (await group(id)).headers.get('etag') } });
const dismissGroup = (id, body) => onGroup('dismiss', id, body);
const confirmGroup = (id, body) => onGroup('confirm', id, body);
const dismissPair = async (id, other) =>
  call(app.url, 'POST', `/patients/${id}/dismiss-duplicates`, { body: other ? { patient: other } : undefined, headers: { 'If-Match': (await detail(id)).headers.get('etag') } });
const linkRecord = async (id, source, fhirId) =>
  call(app.url, 'POST', `/patients/${id}/link`, { body: { source, fhirId }, headers: { 'If-Match': (await detail(id)).headers.get('etag') } });

/** What the table holds, in the terms a person would use: "source/id + source/id (how)". */
const remembered = async () => {
  const { rows } = await pool.query(
    `SELECT ra.source_id || '/' || ra.fhir_id AS a, rb.source_id || '/' || rb.fhir_id AS b, d.via
     FROM dismissed_pairs d JOIN resources ra ON ra.id = d.record_a JOIN resources rb ON rb.id = d.record_b`,
  );
  return rows.map((r) => `${[r.a, r.b].sort().join(' + ')} (${r.via})`).sort();
};

/** Ana Rivera x2 and Ana Riviera, from three sources: every pair resembles each other. */
async function threeLookAlikes() {
  await push('clinic-b', [rivera('a1')]);
  await push('smart', [riviera('s1')]);
  await push('hapi', [rivera('h1')]);
  return { a: await masterOf('clinic-b', 'a1'), s: await masterOf('smart', 's1'), h: await masterOf('hapi', 'h1') };
}

describe('remembering a dismissal', () => {
  test('a group dismissal stores a row for each pair of records in the flags it removed', async () => {
    const { a } = await threeLookAlikes();
    const res = await dismissGroup(a);
    assert.equal(res.status, 200);
    assert.equal(res.body.remembered, 3); // pairs of patients
    assert.deepEqual(await remembered(), ['clinic-b/a1 + hapi/h1 (group)', 'clinic-b/a1 + smart/s1 (group)', 'hapi/h1 + smart/s1 (group)']);
    assert.equal((await groups()).total, 0);
  });

  test('a pair dismissal stores only that pair, a row for each pair of their records', async () => {
    await push('clinic-b', [rivera('a1', mrn('MRN-00417'))]);
    await push('hapi', [rivera('a2', mrn('MRN-00417'))]); // the same record seen again: one patient, two records
    await push('smart', [riviera('b1')]);
    const [a, b] = [await masterOf('clinic-b', 'a1'), await masterOf('smart', 'b1')];
    assert.equal(await masterOf('hapi', 'a2'), a);

    const res = await dismissPair(a, b);
    assert.equal(res.status, 200);
    assert.equal(res.body.remembered, 1); // one pair of patients...
    assert.deepEqual(await remembered(), ['clinic-b/a1 + smart/b1 (pair)', 'hapi/a2 + smart/b1 (pair)']); // ...two pairs of records
  });

  test('dismissing every flag on a patient remembers each pair, and doing it again adds nothing', async () => {
    const { a } = await threeLookAlikes();
    const first = await dismissPair(a);
    assert.equal(first.body.remembered, 2);
    assert.deepEqual(await remembered(), ['clinic-b/a1 + hapi/h1 (pair)', 'clinic-b/a1 + smart/s1 (pair)']);
    const again = await dismissPair(a);
    assert.equal(again.body.remembered, 0);
    assert.equal((await remembered()).length, 2);
  });

  test('dismissing some patients from a group remembers their pairs, not the flags that stay open', async () => {
    const { a, h } = await threeLookAlikes();
    const res = await dismissGroup(a, { patients: [h] });
    assert.equal(res.body.remembered, 2);
    assert.deepEqual(await remembered(), ['clinic-b/a1 + hapi/h1 (group)', 'hapi/h1 + smart/s1 (group)']); // a and s are still flagged
    assert.equal(res.body.remaining.length, 1);
  });

  test('a patient lists who it was dismissed against, under their current ids', async () => {
    const { a, s, h } = await threeLookAlikes();
    assert.deepEqual((await detail(a)).body.dismissedDuplicates, []);
    await dismissGroup(a);
    const { dismissedDuplicates, possibleDuplicates } = (await detail(a)).body;
    assert.deepEqual(possibleDuplicates, []);
    assert.deepEqual(dismissedDuplicates.map((d) => [d.patient, d.via]).sort(), [[h, 'group'], [s, 'group']].sort());
    assert.ok(Date.parse(dismissedDuplicates[0].since) > 0);
    assert.deepEqual((await detail(s)).body.dismissedDuplicates.map((d) => d.patient).sort(), [a, h].sort());
  });
});

describe('a rebuild', () => {
  test('does not raise a dismissed group again, though every golden id changes', async () => {
    const before = await threeLookAlikes();
    await dismissGroup(before.a);

    const result = await rebuildMpi(); // dismissals are not steward work a rebuild loses, so no force
    assert.deepEqual([result.linked, result.patients, result.needReview], [3, 3, 0]);
    assert.deepEqual(result.keptDismissals, { patients: 3, records: 3 });
    assert.equal(result.forgottenDismissals, null);

    const after = { a: await masterOf('clinic-b', 'a1'), s: await masterOf('smart', 's1'), h: await masterOf('hapi', 'h1') };
    for (const key of ['a', 's', 'h']) assert.notEqual(after[key], before[key]); // regenerated: only the source records remember
    assert.equal((await groups()).total, 0);
    assert.deepEqual((await detail(after.a)).body.dismissedDuplicates.map((d) => d.patient).sort(), [after.s, after.h].sort());
  });

  test('does not raise a dismissed pair again but still raises the other pairs', async () => {
    const { a, s } = await threeLookAlikes();
    await dismissPair(a, s);
    await rebuildMpi();
    const [a2, s2, h2] = [await masterOf('clinic-b', 'a1'), await masterOf('smart', 's1'), await masterOf('hapi', 'h1')];
    assert.deepEqual(await flagsOn(a2), [h2]);
    assert.deepEqual(await flagsOn(s2), [h2]);
    assert.deepEqual(await flagsOn(h2), [a2, s2].sort());
  });

  test('raises everything again when told to forget dismissals, and empties the table', async () => {
    const { a } = await threeLookAlikes();
    await dismissGroup(a);
    const result = await rebuildMpi({ forgetDismissals: true });
    assert.deepEqual([result.patients, result.needReview], [3, 3]);
    assert.deepEqual(result.forgottenDismissals, { patients: 3, records: 3 });
    assert.equal(result.keptDismissals, null);
    assert.deepEqual(await remembered(), []);
    const [g] = (await groups()).groups;
    assert.deepEqual([g.size, g.complete], [3, true]);
  });

  test('stands by a dismissal against automatic linking too: only a steward can merge the patients', async () => {
    await push('clinic-b', [patient('a1')]);
    await push('smart', [patient('s1', { birthDate: '1970-05-18' })]); // the same SSN, another birthDate: flagged, not linked
    const a = await masterOf('clinic-b', 'a1');
    assert.match((await groups()).groups[0].reasons[0].reason, /birthDate differs/);
    await dismissGroup(a);
    await push('smart', [patient('s1')]); // the source corrects its typo: now they agree on everything

    const kept = await rebuildMpi();
    assert.deepEqual([kept.patients, kept.needReview], [2, 0]); // a steward said they are different people

    const forgot = await rebuildMpi({ forgetDismissals: true });
    assert.deepEqual([forgot.patients, forgot.needReview], [1, 0]); // without that, the SSN links them
  });

  test('still refuses to run over a manual link without force', async () => {
    const { a } = await threeLookAlikes();
    await dismissGroup(a);
    assert.equal((await linkRecord(a, 'hapi', 'h1')).status, 200);
    await assert.rejects(rebuildMpi(), /1 manual link\(s\) would be lost/);
    assert.equal((await masterOf('hapi', 'h1')), (await masterOf('clinic-b', 'a1'))); // nothing was truncated
    assert.equal((await rebuildMpi({ force: true })).patients, 3);
  });
});

describe('while ingesting', () => {
  test('a new look-alike is a new question, and the dismissed patients stay unflagged among themselves', async () => {
    const { a, s, h } = await threeLookAlikes();
    await dismissGroup(a);
    await push('smart', [rivera('n1')]);
    const n = await masterOf('smart', 'n1');
    assert.equal((await groups()).groups[0].size, 4);
    for (const id of [a, s, h]) assert.deepEqual(await flagsOn(id), [n]);
  });

  test('another record of a dismissed patient does not bring the question back', async () => {
    await push('clinic-b', [rivera('a1', mrn('MRN-00417'))]);
    await push('smart', [riviera('c1')]);
    const [a, c] = [await masterOf('clinic-b', 'a1'), await masterOf('smart', 'c1')];
    await dismissPair(a, c);

    await push('hapi', [rivera('a2', mrn('MRN-00417'))]); // the record seen again: it joins A, and resembles C
    assert.equal(await masterOf('hapi', 'a2'), a);
    assert.deepEqual([await flagsOn(a), await flagsOn(c)], [[], []]);
    assert.equal((await groups()).total, 0);

    // The same arrival with the decision forgotten is the question again.
    await pool.query('DELETE FROM dismissed_pairs');
    await push('hapi', [rivera('a3', mrn('MRN-00417'))]);
    assert.deepEqual(await flagsOn(a), [c]);
  });
});

describe('the latest steward decision wins', () => {
  test('linking records forgets the dismissals between them and keeps the others', async () => {
    const { a, s } = await threeLookAlikes();
    await dismissGroup(a);
    assert.equal((await remembered()).length, 3);
    assert.equal((await linkRecord(s, 'hapi', 'h1')).status, 200); // s1 and h1 are one person now
    assert.deepEqual(await remembered(), ['clinic-b/a1 + hapi/h1 (group)', 'clinic-b/a1 + smart/s1 (group)']);
  });

  test('confirming a group forgets the dismissals inside it', async () => {
    const { a, s } = await threeLookAlikes();
    await dismissPair(a, s); // a chain is left: a-h and s-h
    assert.equal((await remembered()).length, 1);
    assert.equal((await confirmGroup(a)).status, 200);
    assert.deepEqual(await remembered(), []);
  });

  // Dismissals are about people, so merging two patients unites what was ruled out for each.
  // Each case runs twice, the second time with the dismissal left out, to show it is the one thing that differs.
  test('confirming some patients keeps their dismissals, and an answered question does not follow the merge', async () => {
    for (const dismissed of [false, true]) {
      await resetDb();
      const { a, s, h } = await threeLookAlikes();
      if (dismissed) await dismissPair(a, s); // A is not S. H is still flagged against both.
      const res = await confirmGroup(a, { patients: [a, h] }); // A and H are one person
      assert.equal(res.status, 200);
      assert.equal(res.body.survivor, a);
      // S was flagged against H, so the plan moves that flag to the survivor, unless A was ruled out against S.
      assert.deepEqual(res.body.remainingCandidates, dismissed ? [] : [s], `dismissed: ${dismissed}`);
      assert.deepEqual(await flagsOn(s), dismissed ? [] : [a]);
      assert.equal((await groups()).total, dismissed ? 0 : 1);
      assert.deepEqual(await remembered(), dismissed ? ['clinic-b/a1 + smart/s1 (pair)'] : []);
    }
  });

  test('merging a record into a patient does not bring back a question already dismissed for it', async () => {
    for (const dismissed of [false, true]) {
      await resetDb();
      await push('clinic-b', [rivera('a1')]);
      await push('smart', [riviera('c1')]);
      const [a, c] = [await masterOf('clinic-b', 'a1'), await masterOf('smart', 'c1')];
      if (dismissed) await dismissPair(a, c);
      await push('hapi', [rivera('x1')]); // a new patient resembling both
      const x = await masterOf('hapi', 'x1');
      assert.deepEqual(await flagsOn(x), [a, c].sort());

      // The steward decides x1 is A. That empties X, whose flag against C would follow it to A.
      assert.equal((await linkRecord(a, 'hapi', 'x1')).status, 200);
      assert.deepEqual(await flagsOn(a), dismissed ? [] : [c], `dismissed: ${dismissed}`);
      assert.deepEqual(await flagsOn(c), dismissed ? [] : [a]);
      assert.equal((await detail(c)).body.needsReview, !dismissed);
    }
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { call, condition, observation, patient, pool, resetDb, startApp } from './helpers.js';

let app;
let id;
const put = (resource) => ({ resource, request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` } });
const push = (source, resources) =>
  call(app.url, 'POST', `/fhir/${source}`, { body: { resourceType: 'Bundle', type: 'transaction', entry: resources.map(put) } });

before(async () => {
  app = await startApp();
  await resetDb();
  await push('smart', [
    patient('s1'),
    observation('a1', 's1', { when: '2022-02-01T09:00:00Z', value: 6.8 }),
    observation('a2', 's1', { when: '2024-05-01T09:00:00Z', value: 7.1 }),
    observation('g1', 's1', { code: '2345-7', value: 5.5, unit: 'mmol/L', when: '2024-05-01T09:00:00Z' }),
    {
      ...observation('bp', 's1', { code: '85354-9', value: null, when: '2024-05-01T09:05:00Z' }),
      component: [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 128, unit: 'mmHg' } },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 82, system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
      ],
    },
    observation('str', 's1', { code: '17856-6', value: null, when: '2024-08-01', valueString: '6.9 %' }),
    condition('c-snomed', 's1', { code: '44054006', system: 'http://snomed.info/sct' }),
    condition('c-old', 's1', {
      code: 'I10',
      onset: '2015',
      abatementDateTime: '2016-01-01',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'resolved' }] },
    }),
  ]);
  await push('clinic-b', [
    patient('b1', { identifier: [{ system: 'urn:oid:2.16.840.1.113883.4.1', value: '999123456' }] }),
    observation('ifcc', 'b1', { code: '59261-8', system: 'urn:oid:2.16.840.1.113883.6.1', value: 64, unit: 'mmol/mol', when: '2025-01-10T09:00:00Z' }),
    condition('c-icd', 'b1', { code: 'E119', system: 'http://www.cdc.gov/nchs/icd/icd10cm.htm' }),
  ]);
  id = (await call(app.url, 'GET', '/patients')).body.patients[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});

describe('observations by concept', () => {
  test('hba1c resolves every member code, alias and unit across sources', async () => {
    const { body } = await call(app.url, 'GET', `/patients/${id}/observations?concept=hba1c`);
    assert.deepEqual(body.patient.sources.sort(), ['clinic-b', 'smart']);
    assert.deepEqual(body.observations.map((o) => [o.source, o.value, o.unit]), [
      ['clinic-b', 8, '%'], // 64 mmol/mol IFCC -> 0.09148*64 + 2.152 = 8.0 %
      ['smart', 6.9, '%'], // parsed from valueString
      ['smart', 7.1, '%'],
      ['smart', 6.8, '%'],
    ]);
    assert.match(body.observations[0].conversion, /IFCC/);
    assert.equal(body.observations[1].parsedFromString, true);
  });

  test('since filters on the clinical date', async () => {
    const { body } = await call(app.url, 'GET', `/patients/${id}/observations?concept=hba1c&since=2024-01-01`);
    assert.equal(body.count, 3);
  });

  test('components of a blood pressure panel are facts of their own', async () => {
    const { body } = await call(app.url, 'GET', `/patients/${id}/observations?concept=systolic-bp,diastolic-bp`);
    assert.deepEqual(body.observations.map((o) => [o.concept, o.value, o.component]).sort(), [['diastolic-bp', 82, 1], ['systolic-bp', 128, 0]]);
  });

  test('glucose in mmol/L comes back in mg/dL', async () => {
    const { body } = await call(app.url, 'GET', `/patients/${id}/observations?concept=glucose`);
    assert.deepEqual([body.observations[0].value, body.observations[0].original], [99, { value: 5.5, unit: 'mmol/L' }]);
  });

  test('unknown or wrong-domain concepts are rejected with the valid choices', async () => {
    const unknown = await call(app.url, 'GET', `/patients/${id}/observations?concept=a1c`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /hba1c/);
    assert.equal((await call(app.url, 'GET', `/patients/${id}/observations?concept=type-2-diabetes`)).status, 400);
  });
});

describe('conditions by concept', () => {
  test('an undotted ICD-10-CM code under an alias system maps; SNOMED-only is reported, not dropped', async () => {
    const t2dm = await call(app.url, 'GET', `/patients/${id}/conditions?concept=type-2-diabetes`);
    assert.deepEqual(t2dm.body.conditions.map((c) => [c.source, c.codes[0].code]), [['clinic-b', 'E11.9']]);
    const all = await call(app.url, 'GET', `/patients/${id}/conditions`);
    assert.equal(all.body.count, 3);
    assert.deepEqual(all.body.unmapped, { count: 1, snomedOnly: 1 });
  });

  test('status=active excludes resolved conditions', async () => {
    assert.equal((await call(app.url, 'GET', `/patients/${id}/conditions?concept=hypertension`)).body.count, 1);
    assert.equal((await call(app.url, 'GET', `/patients/${id}/conditions?concept=hypertension&status=active`)).body.count, 0);
  });

  test('summary gives the latest value per concept', async () => {
    const { body } = await call(app.url, 'GET', `/patients/${id}/summary`);
    assert.equal(body.latestObservations.hba1c.value, 8);
    assert.equal(body.latestObservations['systolic-bp'].value, 128);
    assert.deepEqual(body.activeConditions.map((c) => c.concept), ['type-2-diabetes']);
    assert.deepEqual(body.unmappedActiveConditions.map((c) => c.id), ['smart/Condition/c-snomed']);
  });
});

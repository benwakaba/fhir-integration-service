import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadIcd10cm } from '../src/terminology/loaders/icd10cm.js';
import { loadLoinc } from '../src/terminology/loaders/loinc.js';
import { validateResource } from '../src/validation/index.js';
import { call, condition, observation, patient, pool, resetDb, startApp } from './helpers.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/terminology/${name}`, import.meta.url));
const rules = (issues) => issues.map((i) => i.rule).sort();

let app;
before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(resetDb);

describe('ICD-10-CM release', () => {
  test('the order file loads headers and billable codes in dotted form', async () => {
    const result = await loadIcd10cm({ file: fixture('icd10cm_order_2026.txt') });
    assert.deepEqual([result.format, result.version, result.codes, result.headers], ['order', 'FY2026', 8, 3]);
    const { rows } = await pool.query(`SELECT code, status FROM codes WHERE system = 'http://hl7.org/fhir/sid/icd-10-cm' ORDER BY code`);
    assert.deepEqual(rows.find((r) => r.code === 'C92.0'), { code: 'C92.0', status: 'header' });
    assert.deepEqual(rows.find((r) => r.code === 'E11.65'), { code: 'E11.65', status: 'active' });
  });

  test('once loaded in full, validation knows headers and non-existent codes', async () => {
    await loadIcd10cm({ file: fixture('icd10cm_order_2026.txt') });
    assert.deepEqual(rules(await validateResource(pool, condition('c1', 'p1', { code: 'C92.0' }))), ['non-billable-code']);
    assert.deepEqual(rules(await validateResource(pool, condition('c1', 'p1', { code: 'E11.99' }))), ['unknown-code']);
    assert.deepEqual(rules(await validateResource(pool, condition('c1', 'p1', { code: 'E11.9' }))), []);
  });

  test('the billable-only codes file loads too', async () => {
    const result = await loadIcd10cm({ file: fixture('icd10cm_codes_2026.txt') });
    assert.deepEqual([result.format, result.codes, result.headers], ['codes', 5, 0]);
  });
});

describe('LOINC release', () => {
  test('Loinc.csv loads by column name, including quoted commas and deprecated status', async () => {
    const result = await loadLoinc({ file: fixture('Loinc.csv'), version: '2.81' });
    assert.equal(result.codes, 5);
    const { rows } = await pool.query(`SELECT code, display, status, properties FROM codes WHERE system = 'http://loinc.org' ORDER BY code`);
    assert.equal(rows.find((r) => r.code === '74774-1').display, 'Glucose [Mass/volume] in Serum, Plasma or Blood');
    assert.equal(rows.find((r) => r.code === '55454-3').status, 'deprecated');
    assert.equal(rows.find((r) => r.code === '4548-4').properties.property, 'MFr');
    assert.deepEqual(rules(await validateResource(pool, observation('o1', 'p1', { code: '55454-3' }))), ['deprecated-code']);
  });

  const withAnswer = (code) =>
    observation('o1', 'p1', { value: null, valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code }] } });

  test('a terms-only load says nothing about answer codes, but does about terms', async () => {
    await loadLoinc({ file: fixture('Loinc.csv'), version: '2.83' });
    assert.deepEqual(rules(await validateResource(pool, withAnswer('LA28373-2'))), []);
    const unknownTerm = await validateResource(pool, observation('o1', 'p1', { code: '2951-2' }));
    assert.deepEqual(rules(unknownTerm), ['unknown-code']);
  });

  test('with answer lists and parts loaded, unknown answer codes are reported', async () => {
    const result = await loadLoinc({ file: fixture('Loinc.csv'), answersFile: fixture('AnswerList.csv'), partsFile: fixture('Part.csv'), version: '2.83' });
    assert.deepEqual(result.includes, ['terms', 'answers', 'answer-lists', 'parts']);
    const { rows } = await pool.query(`SELECT code, display, status FROM codes WHERE code IN ('LA33-6', 'LL1005-9', 'LP173482-3') ORDER BY code`);
    assert.deepEqual(rows, [
      { code: 'LA33-6', display: 'Yes', status: 'active' },
      { code: 'LL1005-9', display: 'PhenX05_18_dietary supplements', status: 'active' },
      { code: 'LP173482-3', display: '1st specimen', status: 'deprecated' },
    ]);
    assert.deepEqual(rules(await validateResource(pool, withAnswer('LA33-6'))), []);
    const unknown = await validateResource(pool, withAnswer('LA28373-2'));
    assert.deepEqual(rules(unknown), ['unknown-code']);
    assert.match(unknown[0].message, /is not an answer code in LOINC 2.83/);
  });
});

describe('lookup API', () => {
  test('given a LOINC code, return the internal concept', async () => {
    const { body } = await call(app.url, 'GET', '/terminology/lookup?system=loinc&code=17856-6');
    assert.deepEqual(body.concepts.map((c) => c.id), ['hba1c']);
    assert.equal(body.found.display, 'Hemoglobin A1c/Hemoglobin.total in Blood by HPLC');
  });

  test('ICD-10-CM codes are normalized before mapping; exclusions explain themselves', async () => {
    const t2dm = await call(app.url, 'GET', '/terminology/lookup?system=http://www.cdc.gov/nchs/icd/icd10cm.htm&code=E1165');
    assert.equal(t2dm.body.code, 'E11.65');
    assert.deepEqual(t2dm.body.normalization, ['system-alias', 'icd10cm-undotted']);
    assert.deepEqual(t2dm.body.concepts.map((c) => c.id), ['type-2-diabetes']);
    const overweight = await call(app.url, 'GET', '/terminology/lookup?system=icd10cm&code=E66.3');
    assert.deepEqual(overweight.body.excludedFrom, [{ concept: 'obesity', reason: 'Overweight, not obesity' }]);
  });

  test('SNOMED CT says why it cannot map', async () => {
    const { body } = await call(app.url, 'GET', '/terminology/lookup?system=snomed&code=44054006');
    assert.equal(body.supported, false);
    assert.match(body.note, /UMLS license/);
  });

  test('WHO ICD-10 is named as unsupported and is not read as ICD-10-CM', async () => {
    const { body } = await call(app.url, 'GET', '/terminology/lookup?system=http://hl7.org/fhir/sid/icd-10&code=I10');
    assert.deepEqual([body.systemName, body.supported, body.system, body.concepts], ['ICD-10 (WHO)', false, 'http://hl7.org/fhir/sid/icd-10', []]);
    assert.match(body.note, /does not load or map/);
    const cm = await call(app.url, 'GET', '/terminology/lookup?system=icd10cm&code=I10');
    assert.deepEqual(cm.body.concepts.map((c) => c.id), ['hypertension']); // same string, different system
  });
});

describe('terminology backlog', () => {
  const push = (resources) =>
    call(app.url, 'POST', '/fhir/clinic-b', {
      body: { resourceType: 'Bundle', type: 'batch', entry: resources.map((r) => ({ resource: r, request: { method: 'PUT', url: `${r.resourceType}/${r.id}` } })) },
    });
  const epic = 'urn:oid:1.2.840.114350.1.13.0.1.7.2.707679';

  test('ranks the codes that reach no concept, and says what kind of work each one is', async () => {
    const uncoded = observation('none', 'p1');
    delete uncoded.code;
    await push([
      patient('p1'),
      observation('mapped', 'p1'), // 4548-4 is hba1c
      observation('na1', 'p1', { code: '2951-2', value: 140, unit: 'mmol/L' }), // sodium: a real LOINC code, no concept
      observation('na2', 'p1', { code: '2951-2', value: 138, unit: 'mmol/L', when: '2024-04-01T10:00:00Z' }),
      observation('flow', 'p1', { system: epic, code: 'FLO-8', value: 3, unit: '1' }), // a vendor's local code
      observation('typo', 'p1', { code: '4548-5' }), // fails the LOINC check digit
      observation('mass', 'p1', { code: '41995-2', value: 0.9, unit: 'g/dL' }), // excluded from hba1c on purpose
      {
        ...observation('bp', 'p1', { code: '85354-9', value: null }), // panel: mapped through its components
        component: [
          { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 120, unit: 'mm[Hg]' } },
          { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 80, unit: 'mm[Hg]' } },
        ],
      },
      uncoded,
    ]);
    const { body } = await call(app.url, 'GET', '/terminology/backlog?resourceType=Observation');
    assert.equal(body.resources, 8);
    assert.deepEqual(body.unmapped, { resources: 6, pct: 75, withoutCoding: 1 });
    assert.deepEqual(body.backlog.map((b) => [b.code, b.resources, b.kind]), [
      ['2951-2', 2, 'unmapped'],
      ['41995-2', 1, 'excluded'],
      ['4548-5', 1, 'invalid'],
      ['FLO-8', 1, 'local'],
    ]);
    assert.match(body.backlog[1].note, /Deliberately not hba1c: Mass concentration/);
    assert.deepEqual(body.byKind.unmapped, { codes: 1, resources: 2 });
    const onlyLocal = await call(app.url, 'GET', '/terminology/backlog?resourceType=Observation&kind=local');
    assert.deepEqual(onlyLocal.body.backlog.map((b) => b.code), ['FLO-8']);
  });

  test('aliased and undotted codes are counted once; SNOMED is reported as needing its release', async () => {
    await push([
      patient('p1'),
      condition('mapped', 'p1'), // E11.9 is type-2-diabetes
      condition('z1', 'p1', { code: 'Z79.4' }), // long-term insulin use: valid, no concept
      condition('z2', 'p1', { code: 'Z794', system: 'http://www.cdc.gov/nchs/icd/icd10cm.htm', onset: '2023-07-01' }),
      condition('sct', 'p1', { code: '44054006', system: 'http://snomed.info/sct', onset: '2023-08-01' }),
    ]);
    const { body } = await call(app.url, 'GET', '/terminology/backlog?resourceType=Condition&source=clinic-b');
    assert.deepEqual(body.backlog.map((b) => [b.system, b.code, b.resources, b.kind]), [
      ['http://hl7.org/fhir/sid/icd-10-cm', 'Z79.4', 2, 'unmapped'],
      ['http://snomed.info/sct', '44054006', 1, 'unsupported-system'],
    ]);
    assert.match(body.backlog[1].note, /UMLS license/);
  });

  test('a code missing from a fully loaded release is invalid, not a mapping candidate', async () => {
    await loadIcd10cm({ file: fixture('icd10cm_order_2026.txt') });
    await push([
      patient('p1'),
      condition('bad', 'p1', { code: 'C95.80' }), // seen in the SMART sandbox; not in ICD-10-CM
      condition('header', 'p1', { code: 'C92.0', onset: '2023-07-01' }),
      condition('family', 'p1', { code: 'E11.99', onset: '2023-08-01' }), // not a real code, but under E11: still type 2 diabetes
    ]);
    const { body } = await call(app.url, 'GET', '/terminology/backlog?resourceType=Condition');
    assert.equal(body.unmapped.resources, 2);
    assert.deepEqual(body.backlog.map((b) => [b.code, b.kind, b.status]).sort(), [
      ['C92.0', 'unmapped', 'header'],
      ['C95.80', 'invalid', undefined],
    ]);
    assert.match(body.backlog.find((b) => b.code === 'C95.80').note, /Not a valid ICD-10-CM code in FY2026/);
  });

  test('standard terminologies the service does not load are named, never called local', async () => {
    await push([
      patient('p1'),
      condition('who', 'p1', { system: 'http://hl7.org/fhir/sid/icd-10', code: 'I10' }), // a code string that also exists in ICD-10-CM
      condition('icd11', 'p1', { system: 'http://id.who.int/icd/release/11/mms', code: 'BA00', onset: '2023-07-01' }),
      condition('theirs', 'p1', { system: 'https://chartr.example/synthetic-workflow', code: 'copd', onset: '2023-08-01' }),
    ]);
    const { body } = await call(app.url, 'GET', '/terminology/backlog?resourceType=Condition');
    assert.equal(body.unmapped.resources, 3); // WHO ICD-10 I10 is not mapped to hypertension
    const byCode = Object.fromEntries(body.backlog.map((b) => [b.code, b]));
    assert.equal(byCode.I10.kind, 'unsupported-system');
    assert.match(byCode.I10.note, /^ICD-10 \(WHO\) is a standard terminology this service does not load or map/);
    assert.equal(byCode.BA00.kind, 'unsupported-system');
    assert.match(byCode.BA00.note, /^ICD-11 MMS /);
    assert.equal(byCode.copd.kind, 'local'); // an invented system really is local
    assert.deepEqual(body.byKind['unsupported-system'], { codes: 2, resources: 2 });
  });

  test('only resource types with a concept domain have a backlog', async () => {
    assert.equal((await call(app.url, 'GET', '/terminology/backlog?resourceType=Patient')).status, 400);
    assert.equal((await call(app.url, 'GET', '/terminology/backlog?source=nowhere')).status, 404);
  });
});

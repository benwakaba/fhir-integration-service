import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadIcd10cm } from '../src/terminology/loaders/icd10cm.js';
import { conformanceReport } from '../src/validation/report.js';
import { call, condition, observation, patient, pool, resetDb, startApp } from './helpers.js';

let report;
before(async () => {
  const app = await startApp();
  await resetDb();
  await loadIcd10cm({ file: fileURLToPath(new URL('./fixtures/terminology/icd10cm_order_2026.txt', import.meta.url)) });
  const english = { communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en-US' }] } }] };
  const { category, ...noCategory } = condition('c1', 'p1');
  const resources = [
    patient('p1', english),
    patient('p2', { identifier: undefined, name: [{ family: 'Okafor', given: ['Chidi'] }], gender: 'male', birthDate: '1980-01-01' }),
    patient('p3', { identifier: undefined, name: [{ family: 'Chen', given: ['Mei'] }], birthDate: '1990-01-01' }),
    noCategory,
    { ...condition('c2', 'p2', { system: 'http://www.cdc.gov/nchs/icd/icd10cm.htm', code: 'I10' }) },
    condition('c3', 'p3', { code: 'C92.0' }), // a category header in the loaded release
    condition('c4', 'p3', { code: 'E11.99' }), // well formed, but not in the release
    observation('o1', 'p1'),
  ];
  await call(app.url, 'POST', '/fhir/clinic-b', {
    body: { resourceType: 'Bundle', type: 'batch', entry: resources.map((r) => ({ resource: r, request: { method: 'PUT', url: `${r.resourceType}/${r.id}` } })) },
  });
  await app.close();
  report = await conformanceReport(pool, 'clinic-b');
});
after(() => pool.end());

test('findings name the gaps a source actually has', () => {
  const text = report.findings.join('\n');
  assert.match(text, /clinic-b omits Patient\.extension:race in 100% of Patient resources \(USCDI requirement, us-core-patient\)/);
  assert.match(text, /clinic-b omits Condition\.category in 25% of Condition resources \(required by us-core-condition-problems-health-concerns\)/);
  assert.match(text, /clinic-b omits Patient\.identifier in 66\.7% of Patient resources \(required by us-core-patient\)/);
  assert.match(text, /Non-canonical system URIs: 1 Condition resources use 'http:\/\/www\.cdc\.gov\/nchs\/icd\/icd10cm\.htm' for ICD-10-CM/);
});

test('coverage uses conditional denominators', () => {
  const patients = report.coverage.find((p) => p.profile === 'us-core-patient');
  const communication = patients.elements.find((e) => e.element === 'Patient.communication');
  assert.deepEqual([communication.present, communication.of, communication.pct], [1, 3, 33.3]);
  const language = patients.elements.find((e) => e.element === 'Patient.communication.language');
  assert.deepEqual([language.present, language.of, language.among], [1, 1, 'Patient.communication']);
});

test('code problems are named, not just counted', () => {
  const text = report.findings.join('\n');
  assert.match(text, /1 Condition resources \(\d+(\.\d+)?%\) use ICD-10-CM category headers, which are not codable diagnoses: C92\.0/);
  assert.match(text, /1 Condition resources \(\d+(\.\d+)?%\) use codes that do not exist in the loaded release: E11\.99/);
});

test('terminology coverage counts mapped resources per element', () => {
  assert.deepEqual(report.terminology['Condition.code'].mappedToConcept, { resources: 3, pct: 75 }); // C92.0 maps to nothing
  assert.deepEqual(report.terminology['Observation.code'].mappedToConcept, { resources: 1, pct: 100 });
});

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { structuralIssues, validateResource } from '../src/validation/index.js';
import { condition, observation, patient, pool, resetDb } from './helpers.js';

const find = (issues, rule) => issues.find((i) => i.rule === rule);

describe('structural validation (schema + generated rules)', () => {
  test('missing required elements: complex (schema) and primitive (StructureDefinition)', () => {
    const { code, status, ...bare } = observation('o1', 'p1');
    const issues = structuralIssues(bare);
    assert.deepEqual(
      issues.filter((i) => i.category === 'missing-required').map((i) => i.path).sort(),
      ['Observation.code', 'Observation.status'],
    );
  });

  test('a primitive satisfied by its _element extension is not missing', () => {
    const { status, ...rest } = observation('o1', 'p1');
    const withExtension = { ...rest, _status: { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }] } };
    assert.ok(!structuralIssues(withExtension).some((i) => i.category === 'missing-required'));
  });

  test('cardinality: a repeating element sent as an object, a single one sent as an array', () => {
    const issues = structuralIssues(patient('p1', { name: { family: 'Rivera' }, gender: ['female'] }));
    assert.equal(find(issues, 'repeating-element-not-array').path, 'Patient.name');
    assert.equal(find(issues, 'max-cardinality-exceeded').path, 'Patient.gender');
  });

  test('required bindings: code enums (schema) and CodeableConcepts (generated rules)', () => {
    assert.equal(find(structuralIssues(patient('p1', { gender: 'M' })), 'required-binding').path, 'Patient.gender');
    const noSystem = condition('c1', 'p1', { clinicalStatus: { coding: [{ code: 'active' }] } });
    assert.match(find(structuralIssues(noSystem), 'required-binding').message, /code 'active' has no system/);
    const stu3 = condition('c1', 'p1', { clinicalStatus: { coding: [{ system: 'http://hl7.org/fhir/condition-clinical', code: 'active' }] } });
    assert.match(find(structuralIssues(stu3), 'required-binding').message, /system 'http:\/\/hl7.org\/fhir\/condition-clinical' is not/);
  });

  test('extensions: unknown is a warning, unknown modifier is an error, missing url is required', () => {
    const issues = structuralIssues(
      patient('p1', {
        extension: [
          { url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex', valueCode: 'F' },
          { url: 'http://example.org/fhir/StructureDefinition/favorite-color', valueString: 'blue' },
          { valueString: 'no url' },
        ],
        modifierExtension: [{ url: 'http://example.org/fhir/StructureDefinition/not-really', valueBoolean: true }],
      }),
    );
    assert.equal(issues.filter((i) => i.category === 'unknown-extension').length, 2);
    assert.equal(find(issues, 'unknown-extension').severity, 'warning');
    assert.equal(find(issues, 'unknown-modifier-extension').severity, 'error');
    assert.equal(find(issues, 'extension-url').category, 'missing-required');
    assert.equal(find(issues, 'unknown-extension').element, "Patient.extension('http://example.org/fhir/StructureDefinition/favorite-color')");
  });

  test('unknown elements, bad primitives, empty arrays, contained resources', () => {
    const issues = structuralIssues(
      observation('o1', 'p1', { comments: 'STU3 field', effectiveDateTime: '2024-03-01T10:00:00', note: [], contained: [{ resourceType: 'Patient', gender: 'x' }] }),
    );
    assert.equal(find(issues, 'unknown-element').path, 'Observation.comments');
    assert.equal(find(issues, 'invalid-dateTime').path, 'Observation.effectiveDateTime');
    assert.equal(find(issues, 'empty-element').path, 'Observation.note');
    assert.equal(find(issues, 'required-binding').path, 'Observation.contained[0].gender');
  });
});

describe('terminology validation', () => {
  before(resetDb);
  after(() => pool.end());

  test('aliases, undotted ICD codes and bad LOINC check digits are reported', async () => {
    const issues = await validateResource(pool, condition('c1', 'p1', { system: 'http://www.cdc.gov/nchs/icd/icd10cm.htm', code: 'E119' }));
    assert.ok(find(issues, 'non-canonical-system'));
    assert.match(find(issues, 'icd10cm-undotted').message, /'E11.9'/);
    const bad = await validateResource(pool, observation('o1', 'p1', { code: '4548-5' }));
    assert.match(find(bad, 'loinc-check-digit').message, /4548 would need -4/);
  });

  test('a seed fragment never claims a code does not exist', async () => {
    const issues = await validateResource(pool, observation('o1', 'p1', { code: '2951-2' })); // sodium: valid, not in the fragment
    assert.ok(!find(issues, 'unknown-code'));
  });
});

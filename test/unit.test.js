import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contentHash } from '../src/fhir/canonical.js';
import { clinicalTime, dateRange } from '../src/fhir/dates.js';
import { parseEtag } from '../src/fhir/present.js';
import { patientRefOf } from '../src/fhir/references.js';
import { describeGroup, dismissedPairs, groupEtag, groupMasters, parseGroupEtag, planConfirm, planDismiss } from '../src/mpi/groups.js';
import { demographicScore, differingIdentifiers, identifierPatterns, jaroWinkler, sharedIdentifiers, trustedIdentifiers } from '../src/mpi/match.js';
import { survive } from '../src/mpi/survivorship.js';
import { conceptsFor, exclusionsFor, getConcept } from '../src/terminology/concepts.js';
import { canonicalSystem, ICD10CM, LOINC, loincCheckDigit, normalizeCode, normalizeCoding } from '../src/terminology/systems.js';
import { quantityUnit, toCanonical } from '../src/terminology/units.js';

describe('code systems', () => {
  test('LOINC check digit holds for every code verified against the NLM LOINC index', () => {
    const verified = `4548-4 17856-6 4549-2 17855-8 62388-4 96595-4 71875-9 59261-8 106634-9 86910-7 41995-2 112870-1
      55454-3 43150-2 2345-7 93791-2 35211-2 1547-9 1558-6 74774-1 18262-6 13457-7 2089-1 22748-8 39469-2 96259-7 2093-3
      14647-2 2085-9 14646-4 2571-8 14927-8 3043-7 2160-0 38483-4 14682-9 77140-2 33914-3 48642-3 48643-1 62238-1 88293-6
      88294-4 98979-8 50044-7 69405-9 2339-0 41653-7 15074-8 14749-6 14771-0 32016-8 51596-5 29463-7 3141-9 8302-2 8306-3
      3137-7 39156-5 8480-6 8462-4 85354-9 55284-4 8867-4 8310-5 2708-6 59408-5 9279-1 14959-1 9318-7 32294-1 13705-9`.split(/\s+/);
    for (const code of verified) {
      const [digits, check] = code.split('-');
      assert.equal(loincCheckDigit(digits), Number(check), code);
    }
    assert.equal(normalizeCode(LOINC, '11290-8').problem, 'loinc-check-digit'); // seen on the HAPI public server
    // Answer codes use a different check-digit scheme; they must not be flagged.
    assert.equal(normalizeCode(LOINC, 'LA33-6').problem, undefined);
    assert.equal(normalizeCode(LOINC, 'LA6576-8').problem, undefined);
  });

  test('ICD-10-CM codes are normalized to the dotted FHIR form', () => {
    assert.deepEqual(normalizeCode(ICD10CM, 'E119'), { code: 'E11.9', problem: 'icd10cm-undotted' });
    assert.deepEqual(normalizeCode(ICD10CM, 'e11.9'), { code: 'E11.9', problem: 'icd10cm-case' });
    assert.deepEqual(normalizeCode(ICD10CM, 'I10'), { code: 'I10' });
    assert.equal(normalizeCode(ICD10CM, 'not-a-code').problem, 'icd10cm-format');
  });

  test('system aliases resolve to canonical URIs; WHO ICD-10 is not ICD-10-CM', () => {
    assert.equal(canonicalSystem('http://www.cdc.gov/nchs/icd/icd10cm.htm'), ICD10CM);
    assert.equal(canonicalSystem('urn:oid:2.16.840.1.113883.6.1'), LOINC);
    assert.equal(canonicalSystem('http://LOINC.org'), LOINC);
    assert.equal(canonicalSystem('http://hl7.org/fhir/sid/icd-10'), 'http://hl7.org/fhir/sid/icd-10');
    assert.deepEqual(normalizeCoding({ system: 'http://www.cdc.gov/nchs/icd/icd10cm.htm', code: 'E119' }).problems, ['system-alias', 'icd10cm-undotted']);
  });
});

describe('concept catalog', () => {
  test('LOINC members map; near misses are excluded with a reason', () => {
    assert.deepEqual(conceptsFor(LOINC, '17856-6').map((m) => m.concept.id), ['hba1c']);
    assert.deepEqual(conceptsFor(LOINC, '86910-7'), []);
    assert.match(exclusionsFor(LOINC, '86910-7')[0].reason, /goal/);
    assert.deepEqual(conceptsFor(LOINC, '1558-6').map((m) => m.concept.id), ['fasting-glucose']);
  });

  test('ICD-10-CM category roots cover their subcodes and nothing adjacent', () => {
    assert.deepEqual(conceptsFor(ICD10CM, 'E11.65').map((m) => m.concept.id), ['type-2-diabetes']);
    assert.deepEqual(conceptsFor(ICD10CM, 'E11').map((m) => m.concept.id), ['type-2-diabetes']);
    assert.deepEqual(conceptsFor(ICD10CM, 'E66.3'), []); // overweight, not obesity
    assert.deepEqual(conceptsFor(ICD10CM, 'I48.3'), []); // flutter, not fibrillation
    assert.deepEqual(conceptsFor(ICD10CM, 'I48.21').map((m) => m.concept.id), ['atrial-fibrillation']);
    assert.deepEqual(conceptsFor(ICD10CM, 'E78.6'), []); // lipoprotein deficiency
    assert.deepEqual(conceptsFor(ICD10CM, 'I11.0').map((m) => m.concept.id).sort(), ['heart-failure', 'hypertension']);
  });
});

describe('units', () => {
  const hba1c = getConcept('hba1c');
  test('IFCC HbA1c converts to NGSP % with the master equation', () => {
    const r = toCanonical({ value: 48, system: 'http://unitsofmeasure.org', code: 'mmol/mol' }, hba1c);
    assert.equal(r.value, 6.5); // 0.09148 * 48 + 2.152 = 6.543
    assert.equal(r.unit, '%');
  });
  test('glucose mmol/L, temperature °F and free-text units convert', () => {
    assert.equal(toCanonical({ value: 5.5, unit: 'mmol/L' }, getConcept('glucose')).value, 99);
    assert.equal(toCanonical({ value: 98.6, unit: '°F' }, getConcept('body-temperature')).value, 37);
    assert.equal(toCanonical({ value: 150, unit: 'lbs' }, getConcept('body-weight')).value, 68);
  });
  test('an unconvertible unit says so instead of guessing', () => {
    const r = toCanonical({ value: 7, unit: 'g/dL' }, hba1c);
    assert.equal(r.value, null);
    assert.equal(r.reason, 'unit-not-convertible');
  });
  test('UCUM coding is recognized only with the UCUM system', () => {
    assert.deepEqual(quantityUnit({ value: 1, unit: 'mg/dl' }), { ucum: 'mg/dL', coded: false });
    assert.deepEqual(quantityUnit({ value: 1, system: 'http://unitsofmeasure.org', code: 'mg/dL' }), { ucum: 'mg/dL', coded: true });
  });
});

describe('FHIR helpers', () => {
  test('partial dates cover their whole period', () => {
    assert.deepEqual(dateRange('2024').map((d) => d.toISOString()), ['2024-01-01T00:00:00.000Z', '2024-12-31T23:59:59.999Z']);
    assert.deepEqual(dateRange('2024-02').map((d) => d.toISOString()), ['2024-02-01T00:00:00.000Z', '2024-02-29T23:59:59.999Z']);
    assert.equal(dateRange('2023-02-30'), null);
    assert.equal(dateRange('2024-03-01T10:00:00-05:00')[0].toISOString(), '2024-03-01T15:00:00.000Z');
  });
  test('an unresolved condition has an open-ended clinical time', () => {
    assert.equal(clinicalTime({ resourceType: 'Condition', onsetDateTime: '2020-01-01' }).end, null);
    assert.ok(clinicalTime({ resourceType: 'Condition', onsetDateTime: '2020', abatementDateTime: '2021-06' }).end);
  });
  test('patient compartment reference, relative or absolute to the source', () => {
    const base = 'https://r4.smarthealthit.org';
    assert.equal(patientRefOf({ resourceType: 'Observation', subject: { reference: 'Patient/1' } }, base), 'Patient/1');
    assert.equal(patientRefOf({ resourceType: 'Observation', subject: { reference: `${base}/Patient/1` } }, base), 'Patient/1');
    assert.equal(patientRefOf({ resourceType: 'Observation', subject: { reference: 'https://elsewhere.org/Patient/1' } }, base), null);
    assert.equal(patientRefOf({ resourceType: 'Immunization', patient: { reference: 'Patient/9' } }, base), 'Patient/9');
  });
  test('content hash ignores server-bumped meta but not tags', () => {
    const a = { resourceType: 'Patient', id: '1', meta: { versionId: '1', lastUpdated: '2020-01-01T00:00:00Z' }, gender: 'male' };
    const b = { ...a, meta: { versionId: '7', lastUpdated: '2025-01-01T00:00:00Z' } };
    assert.equal(contentHash(a), contentHash(b));
    assert.notEqual(contentHash(a), contentHash({ ...a, meta: { tag: [{ code: 'x' }] } }));
  });
  test('ETags parse strong and weak forms', () => {
    assert.equal(parseEtag('W/"3"'), 3);
    assert.equal(parseEtag('"12"'), 12);
    assert.equal(parseEtag('3'), null);
  });
});

describe('matching', () => {
  test('Jaro-Winkler matches the textbook value', () => {
    assert.equal(Math.round(jaroWinkler('martha', 'marhta') * 1000) / 1000, 0.961);
  });
  test('SSNs are matched in every spelling and placeholders never match', () => {
    const [id] = trustedIdentifiers({ identifier: [{ system: 'urn:oid:2.16.840.1.113883.4.1', value: '999851751' }] });
    const values = identifierPatterns(id).map((p) => p.identifier[0].value);
    assert.ok(values.includes('999-85-1751') && values.includes('999851751'));
    assert.deepEqual(trustedIdentifiers({ identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-99-9999' }] }), []);
    assert.deepEqual(trustedIdentifiers({ identifier: [{ system: 'urn:clinic:mrn', value: '123' }] }), []);
  });
  test('a shared identifier counts only with a namespace and a value that could be unique', () => {
    const id = (system, value) => ({ identifier: [{ system, value }] });
    const shared = (a, b) => sharedIdentifiers(a, b);
    assert.deepEqual(shared(id('http://hospital.example/mrn', 'MRN-00417'), id('http://hospital.example/mrn', 'MRN-00417')), ['http://hospital.example/mrn']);
    assert.deepEqual(shared(id('http://hospital.example/mrn', 'MRN-00417'), id('http://other.example/mrn', 'MRN-00417')), []);
    assert.deepEqual(shared(id('http://hospital.example/mrn', 'MRN-00417'), id('http://hospital.example/mrn', 'MRN-00418')), []);
    for (const throwaway of ['12345', '0000', 'test123', 'unknown', '{{patient_mrn}}', 'A1']) {
      assert.deepEqual(shared(id('urn:x', throwaway), id('urn:x', throwaway)), [], throwaway);
    }
    assert.deepEqual(shared({ identifier: [{ value: 'MRN-00417' }] }, { identifier: [{ value: 'MRN-00417' }] }), []); // no namespace
  });

  test('two different values under one trusted system are reported as differing', () => {
    const ssn = (value) => ({ identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value }] });
    assert.deepEqual(differingIdentifiers(ssn('999-12-3456'), ssn('999-65-4321')), ['http://hl7.org/fhir/sid/us-ssn']);
    assert.deepEqual(differingIdentifiers(ssn('999-12-3456'), ssn('999123456')), []); // one SSN, two spellings
    assert.deepEqual(differingIdentifiers(ssn('999-12-3456'), {}), []);
  });

  test('demographic score tolerates a typo but not a different person', () => {
    const a = { gender: 'female', birthDate: '1970-05-17', name: [{ family: 'Rivera', given: ['Ana'] }], address: [{ postalCode: '02110' }] };
    assert.equal(demographicScore(a, { ...a, name: [{ family: 'Rivera', given: ['Ana'] }] }), 1);
    assert.ok(demographicScore(a, { ...a, name: [{ family: 'Riviera', given: ['Ana'] }] }) >= 0.85);
    assert.equal(demographicScore(a, { ...a, name: [{ family: 'Chen', given: ['Ana'] }] }), 0);
    assert.equal(demographicScore(a, { ...a, gender: 'male' }), 0);
  });
});

describe('survivorship', () => {
  const rec = (sourceId, priority, lastUpdated, resource) => ({ sourceId, priority, fhirId: `${sourceId}-1`, lastUpdated: new Date(lastUpdated), resource: { resourceType: 'Patient', ...resource } });
  const older = rec('a', 20, '2021-01-01', { gender: 'female', birthDate: '1970-05-17', address: [{ line: ['1 Old Rd'], postalCode: '02110' }], telecom: [{ system: 'phone', value: '555-111-2222', use: 'home' }] });
  const newer = rec('b', 10, '2025-01-01', { gender: 'female', birthDate: '1970', address: [{ line: ['9 New St'], postalCode: '02139' }], telecom: [{ system: 'phone', value: '(555) 111-2222', use: 'home' }] });

  test('a less precise birthDate refines, it does not conflict', () => {
    const { golden, conflicts } = survive([older, newer]);
    assert.equal(golden.birthDate, '1970-05-17');
    assert.ok(!conflicts.some((c) => c.element === 'birthDate'));
  });
  test('the newest address is current and older ones are kept as use=old', () => {
    const { golden, conflicts } = survive([older, newer]);
    assert.deepEqual(golden.address.map((a) => [a.line[0], a.use]), [['9 New St', undefined], ['1 Old Rd', 'old']]);
    assert.ok(conflicts.some((c) => c.element === 'address' && c.rule === 'most-recent-source'));
  });
  test('the same phone number in two formats is one telecom', () => {
    assert.equal(survive([older, newer]).golden.telecom.length, 1);
  });
  test('missing is not a vote: omitting gender never erases it', () => {
    const { golden, conflicts } = survive([older, rec('b', 10, '2025-01-01', { birthDate: '1970-05-17' })]);
    assert.equal(golden.gender, 'female');
    assert.equal(conflicts.length, 0);
  });
  test('contradictory birthDates need review until a steward overrides', () => {
    const wrong = rec('b', 10, '2025-01-01', { birthDate: '1971-05-17' });
    assert.equal(survive([older, wrong]).needsReview, true);
    const resolved = survive([older, wrong], { birthDate: '1970-05-17' });
    assert.equal(resolved.needsReview, false);
    assert.equal(resolved.golden.birthDate, '1970-05-17');
  });
  test('a death asserted by any source wins over an older "alive"', () => {
    const alive = rec('a', 20, '2025-06-01', { deceasedBoolean: false });
    const dead = rec('b', 10, '2024-01-01', { deceasedDateTime: '2023-12-30' });
    const { golden, conflicts, needsReview } = survive([alive, dead]);
    assert.equal(golden.deceasedDateTime, '2023-12-30');
    assert.equal(golden.deceasedBoolean, undefined);
    assert.ok(conflicts.some((c) => c.element === 'deceased[x]' && c.severity === 'high'));
    assert.equal(needsReview, true);
  });
  test('two different SSNs on one golden record are a high-severity conflict', () => {
    const a = rec('a', 20, '2021-01-01', { identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-12-3456' }] });
    const b = rec('b', 10, '2025-01-01', { identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-65-4321' }] });
    assert.ok(survive([a, b]).conflicts.some((c) => c.element === 'identifier:ssn' && c.severity === 'high'));
  });
});

describe('duplicate groups', () => {
  // A golden patient as the group queries load it: flags are { masterId, reason, score }.
  const flag = (masterId, score = 0.9) => ({ masterId, score, reason: `name and birthDate agree (score ${score}) with no identifier in common` });
  const master = (id, day, flagged = [], extra = {}) => ({
    id,
    version_id: 1,
    created_at: new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`),
    golden: { name: [{ given: ['Ana'], family: 'Rivera' }], birthDate: '1970-05-17', gender: 'female' },
    overrides: {},
    possible_duplicates: flagged.map((f) => (typeof f === 'string' ? flag(f) : f)),
    sources: ['smart'],
    records: 1,
    ...extra,
  });

  test('a group is a connected set of flags, oldest member first; chains are not complete', () => {
    const groups = groupMasters([
      master('c', 3, ['b']),
      master('a', 1, ['b']),
      master('b', 2, ['a', 'c']), // a - b - c: a chain, a and c never flagged
      master('e', 5, ['d']),
      master('d', 4, ['e']),
      master('f', 6), // no flags: not a group
      master('g', 7, ['nobody']), // flagged against a patient that is not there: ignored
    ]);
    assert.deepEqual(groups.map((g) => g.members.map((m) => m.id)), [['a', 'b', 'c'], ['d', 'e']]);
    assert.deepEqual(groups.map((g) => [g.survivor, g.complete, g.records]), [['a', false, 3], ['d', true, 2]]);
  });

  test('the group ETag moves when any member changes and ignores order', () => {
    const [a, b] = [master('a', 1), master('b', 2)];
    assert.equal(groupEtag([a, b]), groupEtag([b, a]));
    assert.notEqual(groupEtag([a, b]), groupEtag([{ ...a, version_id: 2 }, b]));
    assert.notEqual(groupEtag([a, b]), groupEtag([a, b, master('c', 3)]));
    const token = parseGroupEtag(groupEtag([a, b]));
    assert.match(token, /^g-[0-9a-f]{16}$/);
    assert.equal(parseGroupEtag(`"${token}"`), token);
    assert.equal(parseGroupEtag('W/"3"'), null); // a patient ETag is not a group ETag
    assert.equal(parseGroupEtag(undefined), null);
  });

  test('a group is described once per pair, with the weakest score', () => {
    const [group] = groupMasters([master('a', 1, [flag('b', 0.85)]), master('b', 2, [flag('a', 0.85)])]);
    const described = describeGroup(group);
    assert.deepEqual([described.size, described.minScore, described.reasons], [2, 0.85, [{ reason: 'name and birthDate agree (score N) with no identifier in common', pairs: 1 }]]);
    assert.deepEqual(described.patients.map((p) => [p.id, p.name]), [['a', 'Ana Rivera'], ['b', 'Ana Rivera']]);
  });

  test('confirming a whole group settles every flag and merges all but the survivor', () => {
    const members = [master('a', 1, ['b', 'c']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b'])];
    const plan = planConfirm(members, ['a', 'b', 'c'], 'a');
    assert.deepEqual(plan.mergedAway, ['b', 'c']);
    assert.deepEqual([plan.survivorFlags, [...plan.outsiderFlags]], [[], []]);
  });

  test('confirming a subset moves the leftover flags to the survivor, on both sides', () => {
    // d resembles a and c but not b; a, b and c are confirmed as one person.
    const members = [master('a', 1, ['b', 'c', 'd']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b', 'd']), master('d', 4, ['a', 'c'])];
    const plan = planConfirm(members, ['a', 'b', 'c'], 'a');
    assert.deepEqual(plan.mergedAway, ['b', 'c']);
    assert.deepEqual(plan.survivorFlags.map((f) => f.masterId), ['d']);
    assert.deepEqual([...plan.outsiderFlags.keys()], ['d']);
    assert.deepEqual(plan.outsiderFlags.get('d').map((f) => f.masterId), ['a']); // two flags became one
  });

  test('an outsider flagged only from the confirmed side is flagged back', () => {
    const members = [master('a', 1, ['b', 'd']), master('b', 2, ['a']), master('d', 4)]; // d does not list a
    const plan = planConfirm(members, ['a', 'b'], 'a');
    assert.deepEqual(plan.outsiderFlags.get('d').map((f) => f.masterId), ['a']);
    assert.deepEqual(plan.survivorFlags.map((f) => f.masterId), ['d']);
  });

  // The flags a plan leaves behind, applied to the members, so groups can be recomputed from them.
  const applied = (members, plan) => members.map((m) => (plan.has(m.id) ? { ...m, possible_duplicates: plan.get(m.id).map((f) => (typeof f === 'string' ? flag(f) : f)) } : m));

  test('dismissing a whole group clears every flag', () => {
    const members = [master('a', 1, ['b', 'c']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b'])];
    const plan = planDismiss(members, ['a', 'b', 'c']);
    assert.deepEqual([...plan.keys()].sort(), ['a', 'b', 'c']);
    assert.ok([...plan.values()].every((flags) => flags.length === 0));
    assert.deepEqual(groupMasters(applied(members, plan)), []);
  });

  test('dismissing some patients clears them and the flags that pointed at them, and spares everyone else', () => {
    // d resembles a and c; b resembles a and c; nobody else is flagged against b.
    const members = [master('a', 1, ['b', 'c', 'd']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b', 'd']), master('d', 4, ['a', 'c'])];
    const plan = planDismiss(members, ['d']);
    assert.deepEqual([...plan.keys()].sort(), ['a', 'c', 'd']); // b was never flagged against d: untouched
    assert.deepEqual([plan.get('a').map((f) => f.masterId), plan.get('c').map((f) => f.masterId), plan.get('d')], [['b', 'c'], ['a', 'b'], []]);
    const [rest] = groupMasters(applied(members, plan));
    assert.deepEqual([rest.members.map((m) => m.id), rest.complete], [['a', 'b', 'c'], true]); // without d the others are a clique
  });

  test('dismissing the patient that bridges two groups splits them', () => {
    // a and b are one cluster, d and e another, and c is the only link between them.
    const members = [master('a', 1, ['b', 'c']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b', 'd', 'e']), master('d', 4, ['c', 'e']), master('e', 5, ['c', 'd'])];
    assert.equal(groupMasters(members).length, 1);
    const groups = groupMasters(applied(members, planDismiss(members, ['c'])));
    assert.deepEqual(groups.map((g) => g.members.map((m) => m.id)), [['a', 'b'], ['d', 'e']]);
  });

  test('a dismissed patient loses flags that point outside the group too', () => {
    const [a, b] = [master('a', 1, ['b', 'ghost']), master('b', 2, ['a'])];
    assert.deepEqual(planDismiss([a, b], ['a']).get('a'), []);
  });

  describe('what a dismissal remembers', () => {
    const chain = () => [master('a', 1, ['b']), master('b', 2, ['a', 'c']), master('c', 3, ['b'])]; // a and c never flagged

    test('every flagged pair once, in a stable order, and never a pair that was not flagged', () => {
      assert.deepEqual(dismissedPairs(chain(), ['a', 'b', 'c']), [['a', 'b'], ['b', 'c']]); // not ['a', 'c']
      assert.deepEqual(dismissedPairs(chain().reverse(), ['c', 'b', 'a']).map((p) => p.join('|')).sort(), ['a|b', 'b|c']);
    });

    test('dismissing some patients remembers the pairs they were in, not the flags among the rest', () => {
      assert.deepEqual(dismissedPairs(chain(), ['c']), [['b', 'c']]); // a-b stays flagged, so it is not remembered
      assert.deepEqual(dismissedPairs(chain(), ['a']), [['a', 'b']]);
      assert.deepEqual(dismissedPairs([master('a', 1, ['b', 'c']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b'])], ['a', 'b']), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
    });

    test('a flag listed on one side only is still a pair, whichever side lists it, and a flag to oneself is not', () => {
      const members = [master('b', 2, ['a']), master('a', 1), master('c', 3, ['c'])]; // a does not list b back
      assert.deepEqual(dismissedPairs(members, ['a', 'b', 'c']), [['a', 'b']]);
      assert.deepEqual(dismissedPairs(members, ['a']), [['a', 'b']]); // b lists a and only a is dismissed: planDismiss drops that flag too
      assert.deepEqual(dismissedPairs(members, ['b']), [['a', 'b']]); // b is dismissed and lists a
      assert.deepEqual(dismissedPairs(members, ['c']), []); // the flag to itself is nothing
    });

    test('it covers exactly the flags planDismiss removes, in every case planDismiss is tested on', () => {
      const pairsOf = (members) => new Set(members.flatMap((m) => m.possible_duplicates.map((d) => [m.id, d.masterId].sort().join('|'))));
      const cases = [
        { members: [master('a', 1, ['b', 'c']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b'])], dismissed: ['a', 'b', 'c'] },
        { members: [master('a', 1, ['b', 'c', 'd']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b', 'd']), master('d', 4, ['a', 'c'])], dismissed: ['d'] },
        { members: [master('a', 1, ['b', 'c']), master('b', 2, ['a', 'c']), master('c', 3, ['a', 'b', 'd', 'e']), master('d', 4, ['c', 'e']), master('e', 5, ['c', 'd'])], dismissed: ['c'] },
        { members: chain(), dismissed: ['a'] },
        { members: chain(), dismissed: ['b'] },
        { members: [master('b', 2, ['a']), master('a', 1)], dismissed: ['a'] }, // flagged from the other side only
      ];
      for (const { members, dismissed } of cases) {
        const before = pairsOf(members);
        const after = pairsOf(applied(members, planDismiss(members, dismissed)));
        const removed = [...before].filter((pair) => !after.has(pair)).sort();
        assert.deepEqual(dismissedPairs(members, dismissed).map((p) => p.join('|')).sort(), removed, `dismissing ${dismissed}`);
      }
    });
  });
});

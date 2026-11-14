// Simulates a second EHR ("clinic-b") that also knows a patient already ingested
// from SMART, and pushes its record as a FHIR transaction to POST /fhir/clinic-b.
// The data is synthetic and labeled as such; it reproduces discrepancies real
// multi-source feeds have:
//   - the same SSN, spelled differently (digits only, under the SSN OID)
//   - a middle name the first EHR never recorded, a newer address and a different phone
//   - HbA1c reported in IFCC units (mmol/mol, LOINC 59261-8) under a LOINC OID alias
//   - type 2 diabetes coded in ICD-10-CM without its dot, under the CDC's URI
//   - one lab result both EHRs received (a cross-source duplicate)
//
//   npm run demo:second-source -- --name gerlach
//   npm run demo:second-source -- --patient <golden patient id>

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import pool from '../src/db/pool.js';

const { values } = parseArgs({
  options: {
    patient: { type: 'string' },
    name: { type: 'string' },
    base: { type: 'string', default: `http://localhost:${config.port}` },
  },
});

// Stable ids, so re-running updates clinic-b's records instead of duplicating them.
const uuid = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function pickSmartPatient() {
  const { rows } = await pool.query(
    `SELECT r.fhir_id, r.resource, pl.master_id
     FROM resources r JOIN patient_links pl ON pl.resource_id = r.id
     WHERE r.source_id = 'smart' AND r.resource_type = 'Patient' AND NOT r.deleted
       AND ($1::uuid IS NULL OR pl.master_id = $1)
       AND ($2::text IS NULL OR lower((r.resource->'name')::text) LIKE $2)
       AND EXISTS (SELECT 1 FROM resources o WHERE o.source_id = 'smart' AND o.patient_ref = 'Patient/' || r.fhir_id
                   AND o.resource @> '{"code":{"coding":[{"code":"4548-4"}]}}')
     ORDER BY r.id LIMIT 1`,
    [values.patient ?? null, values.name ? `%${values.name.toLowerCase()}%` : null],
  );
  if (!rows[0]) throw new Error('No matching SMART patient with an HbA1c result; ingest one first (npm run ingest -- --has-code http://loinc.org|4548-4)');
  const { rows: labs } = await pool.query(
    `SELECT resource FROM resources
     WHERE source_id = 'smart' AND patient_ref = $1 AND resource @> '{"code":{"coding":[{"code":"4548-4"}]}}'
     ORDER BY effective_start DESC LIMIT 1`,
    [`Patient/${rows[0].fhir_id}`],
  );
  return { ...rows[0], latestA1c: labs[0].resource };
}

function buildBundle(smart) {
  const p = smart.resource;
  const ssn = p.identifier?.find((i) => i.system === 'http://hl7.org/fhir/sid/us-ssn')?.value;
  if (!ssn) throw new Error(`SMART patient ${smart.fhir_id} has no SSN to share`);
  const official = p.name?.find((n) => n.use === 'official') ?? p.name?.[0];
  const patientUrl = `urn:uuid:${uuid(`clinic-b/patient/${smart.fhir_id}`)}`;
  const now = new Date();
  const monthsAgo = (n) => new Date(now.getFullYear(), now.getMonth() - n, 15, 9, 30).toISOString();

  const patient = {
    resourceType: 'Patient',
    meta: { lastUpdated: now.toISOString() },
    identifier: [
      { system: 'urn:oid:2.16.840.1.113883.4.1', value: ssn.replace(/\D/g, '') },
      { system: 'urn:oid:1.2.3.4.5.clinic-b.mrn', value: `CB-${smart.fhir_id.slice(0, 6).toUpperCase()}` },
    ],
    name: [{ use: 'official', family: official.family, given: [official.given[0], 'Marie'] }], // clinic-b records a middle name
    telecom: [{ system: 'phone', value: '(555) 010-4477', use: 'home' }],
    gender: p.gender,
    birthDate: p.birthDate,
    address: [{ use: 'home', line: ['400 Harbor Point Blvd', 'Apt 12'], city: 'Boston', state: 'MA', postalCode: '02125' }],
  };

  const ifccA1c = (months, mmolPerMol) => ({
    fullUrl: `urn:uuid:${uuid(`clinic-b/a1c/${smart.fhir_id}/${months}`)}`,
    resource: {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      code: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.1', code: '59261-8', display: 'HbA1c (IFCC)' }], text: 'HbA1c IFCC' },
      subject: { reference: patientUrl },
      effectiveDateTime: monthsAgo(months),
      valueQuantity: { value: mmolPerMol, unit: 'mmol/mol', system: 'http://unitsofmeasure.org', code: 'mmol/mol' },
    },
    request: { method: 'POST', url: 'Observation' },
  });

  // The same result SMART already holds, as clinic-b received it from the lab.
  const shared = smart.latestA1c;
  const sharedLab = {
    fullUrl: `urn:uuid:${uuid(`clinic-b/shared/${shared.id}`)}`,
    resource: {
      resourceType: 'Observation',
      status: shared.status,
      category: shared.category,
      code: shared.code,
      subject: { reference: patientUrl },
      effectiveDateTime: shared.effectiveDateTime,
      valueQuantity: shared.valueQuantity,
    },
    request: { method: 'POST', url: 'Observation' },
  };

  const diabetes = {
    fullUrl: `urn:uuid:${uuid(`clinic-b/t2dm/${smart.fhir_id}`)}`,
    resource: {
      resourceType: 'Condition',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
      code: { coding: [{ system: 'http://www.cdc.gov/nchs/icd/icd10cm.htm', code: 'E119', display: 'Type 2 diabetes mellitus without complications' }] },
      subject: { reference: patientUrl },
      onsetDateTime: monthsAgo(14).slice(0, 10),
    },
    request: { method: 'POST', url: 'Condition' },
  };

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      { fullUrl: patientUrl, resource: patient, request: { method: 'POST', url: 'Patient' } },
      ifccA1c(1, 58),
      ifccA1c(7, 53),
      sharedLab,
      diabetes,
    ],
  };
}

try {
  const smart = await pickSmartPatient();
  const bundle = buildBundle(smart);
  const headers = { 'content-type': 'application/fhir+json', ...(config.apiKey && { authorization: `Bearer ${config.apiKey}` }) };
  const response = await fetch(`${values.base}/fhir/clinic-b`, { method: 'POST', headers, body: JSON.stringify(bundle) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.issue?.[0]?.diagnostics ?? JSON.stringify(body)}`);
  console.log(`clinic-b pushed ${bundle.entry.length} resources for SMART patient ${smart.fhir_id}:`);
  for (const [i, e] of body.entry.entries()) console.log(`  ${e.response.status.padEnd(12)} ${e.response.location ?? ''}${e.response.outcome ? `  (${e.response.outcome.issue.length} validation issues)` : ''}`);
  console.log(`\nGolden patient: ${values.base}/patients/${smart.master_id}`);
  console.log(`HbA1c across both sources: ${values.base}/patients/${smart.master_id}/observations?concept=hba1c`);
  console.log(`Merged record: ${values.base}/patients/${smart.master_id}/$everything`);
} catch (err) {
  console.error(`Simulation failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

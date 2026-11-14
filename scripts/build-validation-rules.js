// Generates src/validation/generated/r4-rules.json from HL7's published packages:
//   hl7.fhir.r4.core#4.0.1  - base R4 StructureDefinitions, ValueSets, CodeSystems
//   hl7.fhir.us.core#6.1.0  - US Core profiles (the ONC HTI-1 certification baseline)
//
// The JSON Schema cannot express three things the StructureDefinitions do, so they
// are extracted here instead of being hand-written:
//   requiredPrimitives  - primitive elements with min >= 1 (e.g. Observation.status)
//   requiredBindings    - CodeableConcept/Coding elements with a required binding,
//                         with the bound ValueSet expanded to its codes
//   knownExtensions     - every extension defined by either package
//   mustSupport         - US Core Must Support elements per profile (for coverage reports)
//
// Packages are fetched from the FHIR package registry into .fhir-packages/ (or
// $FHIR_PACKAGE_CACHE). The generated file is committed, so this only needs to run
// when changing package versions.
//
//   npm run rules:build

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.FHIR_PACKAGE_CACHE ?? path.join(ROOT, '.fhir-packages');
const OUT = path.join(ROOT, 'src/validation/generated/r4-rules.json');

const CORE = { id: 'hl7.fhir.r4.core', version: '4.0.1' };
const US_CORE = { id: 'hl7.fhir.us.core', version: '6.1.0' };

// Resource types whose rules are emitted. Anything else still gets schema validation.
const RESOURCE_TYPES = [
  'Patient', 'Observation', 'Condition', 'Encounter', 'AllergyIntolerance', 'Immunization',
  'MedicationRequest', 'Procedure', 'DiagnosticReport', 'Practitioner', 'Organization',
  'Location', 'Bundle', 'Provenance', 'DocumentReference', 'CarePlan', 'Goal', 'Device',
];

const US_CORE_PROFILES = [
  'us-core-patient',
  'us-core-condition-problems-health-concerns',
  'us-core-condition-encounter-diagnosis',
  'us-core-observation-lab',
  'us-core-vital-signs',
  'us-core-encounter',
  'us-core-allergyintolerance',
  'us-core-immunization',
  'us-core-medicationrequest',
  'us-core-procedure',
];

const PRIMITIVES = new Set([
  'base64Binary', 'boolean', 'canonical', 'code', 'date', 'dateTime', 'decimal', 'id', 'instant', 'integer',
  'markdown', 'oid', 'positiveInt', 'string', 'time', 'unsignedInt', 'uri', 'url', 'uuid', 'xhtml',
]);

async function ensurePackage({ id, version }) {
  const dir = path.join(CACHE, `${id}#${version}`);
  if (existsSync(path.join(dir, 'package', 'package.json'))) return path.join(dir, 'package');
  mkdirSync(dir, { recursive: true });
  const url = `https://packages.fhir.org/${id}/${version}`;
  console.log(`Fetching ${id}#${version} from ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  const tarball = path.join(dir, 'package.tgz');
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  return path.join(dir, 'package');
}

function readPackage(dir) {
  const byType = { StructureDefinition: [], ValueSet: new Map(), CodeSystem: new Map() };
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('.') || file === 'package.json') continue;
    const [prefix] = file.split('-');
    if (!['StructureDefinition', 'ValueSet', 'CodeSystem'].includes(prefix)) continue;
    const resource = JSON.parse(readFileSync(path.join(dir, file), 'utf-8'));
    if (resource.resourceType === 'StructureDefinition') byType.StructureDefinition.push(resource);
    else if (resource.resourceType === 'ValueSet') byType.ValueSet.set(resource.url, resource);
    else if (resource.resourceType === 'CodeSystem') byType.CodeSystem.set(resource.url, resource);
  }
  return byType;
}

// --- ValueSet expansion (enough for the small, enumerated sets used by required bindings)

function flattenConcepts(concepts, out = []) {
  for (const c of concepts ?? []) {
    out.push(c);
    flattenConcepts(c.concept, out);
  }
  return out;
}

function descendantsOf(concepts, code) {
  const found = flattenConcepts(concepts).find((c) => c.code === code);
  return found ? flattenConcepts(found.concept) : null;
}

function expand(valueSetUrl, pkgs, seen = new Set()) {
  const url = valueSetUrl.split('|')[0];
  if (seen.has(url)) return null;
  seen.add(url);
  const vs = pkgs.valueSets.get(url);
  if (!vs?.compose) return null;
  const include = (part) => {
    const codes = new Set();
    for (const inner of part.valueSet ?? []) {
      const nested = expand(inner, pkgs, seen);
      if (!nested) return null;
      nested.forEach((c) => codes.add(c));
    }
    if (!part.system) return codes;
    if (part.concept) {
      part.concept.forEach((c) => codes.add(`${part.system}|${c.code}`));
      return codes;
    }
    const cs = pkgs.codeSystems.get(part.system);
    if (!cs || cs.content !== 'complete') return null; // external or partial system: cannot expand offline
    let concepts = flattenConcepts(cs.concept);
    for (const filter of part.filter ?? []) {
      if (!['is-a', 'descendent-of'].includes(filter.op) || filter.property !== 'concept') return null;
      const below = descendantsOf(cs.concept, filter.value);
      if (!below) return null;
      const self = filter.op === 'is-a' ? flattenConcepts(cs.concept).filter((c) => c.code === filter.value) : [];
      concepts = [...self, ...below];
    }
    concepts.forEach((c) => codes.add(`${part.system}|${c.code}`));
    return codes;
  };
  const result = new Set();
  for (const part of vs.compose.include ?? []) {
    const codes = include(part);
    if (!codes) return null;
    codes.forEach((c) => result.add(c));
  }
  for (const part of vs.compose.exclude ?? []) {
    const codes = include(part);
    if (!codes) return null;
    codes.forEach((c) => result.delete(c));
  }
  return result;
}

// --- Rule extraction

function relative(pathStr) {
  return pathStr.split('.').slice(1).join('.');
}

function extractResourceRules(sd, pkgs, skipped) {
  const requiredPrimitives = [];
  const requiredBindings = [];
  for (const el of sd.snapshot.element) {
    const rel = relative(el.path);
    if (!rel || el.path.endsWith('.id') || /\.(extension|modifierExtension)$/.test(el.path)) continue;
    const types = (el.type ?? []).map((t) => t.code);
    // Elements inside datatypes do not appear in a resource snapshot; everything here
    // is the resource's own element or a backbone element.
    if (el.min >= 1 && types.length && types.every((t) => PRIMITIVES.has(t) || t.startsWith('http://hl7.org/fhirpath'))) {
      requiredPrimitives.push(
        rel.endsWith('[x]')
          ? { path: rel, variants: types.map((t) => rel.replace('[x]', t[0].toUpperCase() + t.slice(1))) }
          : { path: rel },
      );
    }
    const coded = types.filter((t) => t === 'CodeableConcept' || t === 'Coding');
    if (el.binding?.strength === 'required' && coded.length && !rel.includes('[x]')) {
      const codes = expand(el.binding.valueSet, pkgs);
      if (!codes) {
        skipped.push({ path: el.path, valueSet: el.binding.valueSet, reason: 'value set not expandable offline' });
        continue;
      }
      requiredBindings.push({ path: rel, type: coded[0], valueSet: el.binding.valueSet.split('|')[0], codes: [...codes].sort() });
    }
  }
  return { requiredPrimitives, requiredBindings };
}

const USCDI_REQUIREMENT = 'http://hl7.org/fhir/us/core/StructureDefinition/uscdi-requirement';

// US Core 6.1 flags data elements two ways: mustSupport, and (for USCDI elements
// such as race, ethnicity and Patient.communication that are not mustSupport)
// the uscdi-requirement extension. Coverage reports track both, labeled.
function extractMustSupport(profile) {
  const elements = [];
  for (const el of profile.snapshot.element) {
    const uscdi = (el.extension ?? []).some((x) => x.url === USCDI_REQUIREMENT && x.valueBoolean === true);
    if (!(el.mustSupport || uscdi) || !el.path.includes('.')) continue;
    const extensionUrl = /\.extension$/.test(el.path) && el.sliceName ? el.type?.[0]?.profile?.[0] : undefined;
    // Only extension slices are tracked individually; other slices (e.g. category:us-core)
    // are covered by their unsliced base element.
    if (el.sliceName && !extensionUrl) continue;
    if (el.id.split('.').slice(1).some((part) => part.includes(':') && !part.startsWith('extension:'))) continue;
    elements.push({ path: el.id, min: el.min ?? 0, mustSupport: Boolean(el.mustSupport), uscdi, ...(extensionUrl && { extensionUrl }) });
  }
  return { url: profile.url, resourceType: profile.type, title: profile.title, elements };
}

async function main() {
  const coreDir = await ensurePackage(CORE);
  const usCoreDir = await ensurePackage(US_CORE);
  const core = readPackage(coreDir);
  const usCore = readPackage(usCoreDir);
  const pkgs = {
    valueSets: new Map([...core.ValueSet, ...usCore.ValueSet]),
    codeSystems: new Map([...core.CodeSystem, ...usCore.CodeSystem]),
  };

  const skippedBindings = [];
  const resources = {};
  for (const type of RESOURCE_TYPES) {
    const sd = core.StructureDefinition.find((s) => s.url === `http://hl7.org/fhir/StructureDefinition/${type}`);
    if (!sd) throw new Error(`No StructureDefinition for ${type}`);
    resources[type] = extractResourceRules(sd, pkgs, skippedBindings);
  }

  const knownExtensions = [...core.StructureDefinition, ...usCore.StructureDefinition]
    .filter((sd) => sd.type === 'Extension' && sd.derivation === 'constraint')
    .map((sd) => sd.url)
    .sort();

  const mustSupport = {};
  for (const id of US_CORE_PROFILES) {
    const profile = usCore.StructureDefinition.find((s) => s.id === id);
    if (!profile) throw new Error(`No US Core profile ${id}`);
    mustSupport[id] = extractMustSupport(profile);
  }

  const rules = {
    generatedFrom: [`${CORE.id}#${CORE.version}`, `${US_CORE.id}#${US_CORE.version}`],
    resources,
    knownExtensions,
    mustSupport,
    skippedBindings,
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(rules, null, 1)}\n`);
  const count = (key) => Object.values(resources).reduce((n, r) => n + r[key].length, 0);
  console.log(
    `Wrote ${path.relative(ROOT, OUT)}: ${count('requiredPrimitives')} required primitives, ` +
      `${count('requiredBindings')} required bindings (${skippedBindings.length} skipped), ` +
      `${knownExtensions.length} known extensions, ${Object.keys(mustSupport).length} US Core profiles`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

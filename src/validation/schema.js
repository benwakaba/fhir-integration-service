// Layer 1: structural validation against the HL7 FHIR R4 JSON Schema (fhir.schema.json,
// draft-06), compiled with Ajv. The schema file comes from
// @asymmetrik/fhir-json-schema-validator, which ships it unmodified; ARCHITECTURE.md
// records how it was checked against the official 4.0.1 StructureDefinitions.
//
// The schema catches: missing required *complex* elements, unknown elements
// (additionalProperties: false), array-vs-single mistakes, required-binding
// `code` values (enums), and primitive formats. It cannot catch missing required
// *primitives* (they may legally be replaced by a `_element` extension), required
// bindings on CodeableConcepts, or unknown extensions. Layer 2 (rules.js) does those.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Ajv from 'ajv';

const require = createRequire(import.meta.url);
const SCHEMA_ID = 'http://hl7.org/fhir/json-schema/4.0';

let ajv;
const compiled = new Map();

function load() {
  if (ajv) return ajv;
  const schema = JSON.parse(readFileSync(require.resolve('@asymmetrik/fhir-json-schema-validator/fhir.schema.json'), 'utf-8'));
  const draft06 = JSON.parse(readFileSync(require.resolve('ajv/dist/refs/json-schema-draft-06.json'), 'utf-8'));
  // The schema names itself with the draft-04 `id` keyword, which Ajv 8 rejects.
  delete schema.id;
  schema.$id = SCHEMA_ID;
  // strict:false tolerates the schema's non-standard `discriminator` keyword.
  ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
  ajv.addMetaSchema(draft06);
  ajv.addSchema(schema, SCHEMA_ID);
  ajv.resourceTypes = new Set(Object.keys(schema.discriminator.mapping));
  // Element definitions inline their primitive's pattern, so a pattern failure only
  // says which regex failed. Map each pattern back to the primitive that owns it.
  ajv.primitiveByPattern = new Map(
    Object.entries(schema.definitions)
      .filter(([, def]) => typeof def.pattern === 'string')
      .map(([name, def]) => [def.pattern, name]),
  );
  return ajv;
}

/** The FHIR primitive type a schema pattern belongs to ('dateTime', 'code', ...). */
export function primitiveForPattern(pattern) {
  return load().primitiveByPattern.get(pattern) ?? null;
}

export function isKnownResourceType(type) {
  return load().resourceTypes.has(type);
}

function validatorFor(type) {
  if (!compiled.has(type)) compiled.set(type, load().getSchema(`${SCHEMA_ID}#/definitions/${type}`));
  return compiled.get(type);
}

/**
 * Raw Ajv errors for one resource. Contained resources are validated one by one
 * against their own type: validating them through the schema's 146-way `oneOf`
 * would bury the real error under a failure report for every other resource type.
 */
export function schemaErrors(resource) {
  const { contained, ...rest } = resource;
  const validate = validatorFor(resource.resourceType);
  const errors = validate(rest) ? [] : [...validate.errors];
  (Array.isArray(contained) ? contained : []).forEach((inner, i) => {
    const prefix = `/contained/${i}`;
    if (!inner || typeof inner !== 'object' || !isKnownResourceType(inner.resourceType)) {
      errors.push({ instancePath: prefix, keyword: 'resourceType', params: { value: inner?.resourceType }, message: 'unknown resourceType' });
      return;
    }
    for (const err of schemaErrors(inner)) errors.push({ ...err, instancePath: prefix + err.instancePath });
  });
  if (contained !== undefined && !Array.isArray(contained)) {
    errors.push({ instancePath: '/contained', keyword: 'type', params: { type: 'array' }, message: 'must be array' });
  }
  return errors;
}

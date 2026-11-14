// Validation entry point. Three layers, one issue shape:
//   1. schema.js      - HL7 R4 JSON Schema via Ajv (structure, types, enums, formats)
//   2. rules.js       - rules generated from the R4/US Core StructureDefinitions
//   3. terminology.js - codes checked against loaded LOINC / ICD-10-CM releases
// Ajv errors are translated into the service's categories here.

import { findCodes, loadedSystems } from '../terminology/service.js';
import { normalizeCoding } from '../terminology/systems.js';
import { isKnownResourceType, primitiveForPattern, schemaErrors } from './schema.js';
import { ruleIssues } from './rules.js';
import { collectCodings, terminologyIssues } from './terminology.js';
import { Category, issue, valueAt } from './issues.js';

/** Layers 1 and 2: everything that needs no database. */
export function structuralIssues(resource) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    return [issue({ category: Category.INVALID_VALUE, rule: 'not-a-resource', resourceType: 'Resource', message: 'Body is not a JSON object' })];
  }
  if (!isKnownResourceType(resource.resourceType)) {
    return [
      issue({
        category: Category.INVALID_VALUE,
        rule: 'unknown-resource-type',
        resourceType: 'Resource',
        pointer: '/resourceType',
        message: `'${resource.resourceType}' is not an R4 resource type`,
      }),
    ];
  }
  const fromSchema = schemaErrors(resource).map((err) => fromAjv(err, resource));
  return [...fromSchema, ...ruleIssues(resource)];
}

/** All three layers for a batch, with one terminology query for the whole batch. */
export async function validateResources(db, resources) {
  const codingsByResource = resources.map((r) => (r && typeof r === 'object' ? collectCodings(r) : []));
  const pairs = codingsByResource.flat().map(({ coding }) => normalizeCoding(coding));
  const [systems, codes] = await Promise.all([loadedSystems(db), findCodes(db, pairs)]);
  return resources.map((resource, i) => {
    const structural = structuralIssues(resource);
    if (structural.some((x) => x.rule === 'unknown-resource-type' || x.rule === 'not-a-resource')) return structural;
    return [...structural, ...terminologyIssues(resource, codingsByResource[i], { systems, codes })];
  });
}

export async function validateResource(db, resource) {
  return (await validateResources(db, [resource]))[0];
}

function fromAjv(err, resource) {
  const resourceType = resource.resourceType;
  const at = (pointer, fields) => issue({ resourceType, pointer, ...fields });
  const value = valueAt(resource, err.instancePath);

  switch (err.keyword) {
    case 'required':
      return at(`${err.instancePath}/${err.params.missingProperty}`, {
        category: Category.MISSING_REQUIRED,
        rule: 'required-element',
        message: `Required element '${err.params.missingProperty}' is missing`,
      });
    case 'additionalProperties':
      return at(`${err.instancePath}/${err.params.additionalProperty}`, {
        category: Category.UNKNOWN_ELEMENT,
        rule: 'unknown-element',
        message: `'${err.params.additionalProperty}' is not an R4 element here`,
      });
    case 'type':
      if (err.params.type === 'array') {
        return at(err.instancePath, {
          category: Category.CARDINALITY,
          rule: 'repeating-element-not-array',
          message: 'Element repeats (max cardinality *) and must be a JSON array, even with one value',
        });
      }
      if (Array.isArray(value)) {
        return at(err.instancePath, {
          category: Category.CARDINALITY,
          rule: 'max-cardinality-exceeded',
          message: `Element allows a single value (max cardinality 1) but ${value.length} were sent as an array`,
        });
      }
      return at(err.instancePath, {
        category: Category.INVALID_VALUE,
        rule: 'wrong-type',
        message: `Expected ${err.params.type}, got ${value === null ? 'null' : typeof value}`,
      });
    case 'enum':
      // Code elements carry only an enum in the schema, so an array there fails
      // the enum; it is a cardinality problem, not a wrong code.
      if (Array.isArray(value)) {
        return at(err.instancePath, {
          category: Category.CARDINALITY,
          rule: 'max-cardinality-exceeded',
          message: `Element allows a single value (max cardinality 1) but ${value.length} were sent as an array`,
        });
      }
      return at(err.instancePath, {
        category: Category.INVALID_CODE,
        rule: 'required-binding',
        message: `'${value}' is not in the required value set (${err.params.allowedValues.join(' | ')})`,
      });
    case 'pattern': {
      const primitive = primitiveForPattern(err.params.pattern) ?? 'value';
      return at(err.instancePath, {
        category: Category.INVALID_VALUE,
        rule: `invalid-${primitive}`,
        message: `'${String(value).slice(0, 60)}' is not a valid FHIR ${primitive}`,
      });
    }
    default:
      return at(err.instancePath, {
        category: Category.INVALID_VALUE,
        rule: err.keyword,
        message: err.message,
      });
  }
}

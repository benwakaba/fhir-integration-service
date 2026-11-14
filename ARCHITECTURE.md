# Architecture

```
 pull: SMART, HAPI ──(paginate, retry, incremental)──┐
                                                    ├──► write pipeline ──► PostgreSQL
 push: POST /fhir/{source} (transaction | batch) ───┘    1. store a version        resources (JSONB + GIN)
                                                         2. validate (3 layers)    resource_versions (append-only)
                                                         3. update the patient     validation_issues
                                                            index (golden record)  codes / code_systems
                                                                                   master_patients, patient_links
                                                                     │
      /patients (developer API) ◄── query by concept ◄──────────────┤
      /fhir/{source}, /fhir/golden (versioned FHIR) ◄───────────────┤
      /conformance, /terminology ◄──────────────────────────────────┘
```

Every source, pulled or pushed, goes through the same write path
(`src/ingest/pipeline.js`), so versioning, validation and matching behave identically
whatever the transport.

## Storage: whole resources as JSONB

A FHIR resource is deeply nested and almost everything in it is optional, so a relational
model either explodes into hundreds of sparse tables or silently drops what it did not
anticipate. Each resource version is stored whole, exactly as the source sent it. The only
columns derived from the JSON are:

- identity and versioning: `resource_type`, `fhir_id`, `version_id` (ours), `source_version_id` and `last_updated` (the source's), `content_hash`;
- a small search index computed at write time: `patient_ref` (the patient compartment, resolved from `subject`/`patient`, relative or absolute) and `effective_start`/`effective_end`. The last two are the clinical time range with FHIR's partial-date semantics, so `'2024-03'` covers all of March and an unresolved Condition is open-ended.

That index is the same idea as a FHIR server's search-parameter tables. The JSON stays the
source of truth and nothing is decomposed per element.

The JSONB has a `jsonb_path_ops` GIN index (smaller and faster than the default opclass for
`@>`). Matching queries use containment, written as explicit `OR`s rather than
`@> ANY(...)` so the planner can combine index scans. From the development database
(27,215 resources, 33 MB heap, 9.2 MB GIN), the MPI's SSN lookup across two spellings:

```
Bitmap Heap Scan on resources r
  Recheck Cond: ((resource @> '{"identifier": [{"value": "999-85-1751", "system": "http://hl7.org/fhir/sid/us-ssn"}]}')
              OR (resource @> '{"identifier": [{"value": "999851751", "system": "urn:oid:2.16.840.1.113883.4.1"}]}'))
  ->  BitmapOr
        ->  Bitmap Index Scan on idx_resources_jsonb
        ->  Bitmap Index Scan on idx_resources_jsonb
```

The conformance report measures element presence with jsonpath (`resource @? '$.communication.language'`;
lax mode walks arrays), so coverage is always computed from the store as it is.

## Versioning

- **Two version numbers.** `source_version_id` is what the source reported, kept for provenance and sync. `version_id` is this service's own counter, and it backs `meta.versionId` and `ETag: W/"n"` on our API. The two cannot be the same number: edits made through this API create versions the source never had.
- **Content, not counters, decides.** `content_hash` is a SHA-256 of canonical JSON (sorted keys) without `meta.versionId/lastUpdated/source`. A source that bumps its version without changing anything updates the pointer and mints no version. A real change always mints one.
- **Append-only history.** Every version is also written to `resource_versions`, including deletions (soft: a version flagged `deleted`; reads answer 410 Gone, `_history` still has everything).
- **Lost updates.** Writes lock the row (`SELECT ... FOR UPDATE`) and compare `If-Match` inside the same transaction. A test fires three concurrent PUTs from version 1: exactly one gets 200 and two get 412. `If-Match` is required on updates (428 without) because this service declares `versioned-update`.
- **Provenance on read.** `meta.source` is the exact source version, e.g. `https://r4.smarthealthit.org/Observation/{id}/_history/4`.

## Ingest

**Pagination** (`src/fhir/paginate.js`) follows `Bundle.link[relation=next]` verbatim. HAPI's
next link is an opaque `_getpages` cursor on the server base, not an offset, so rebuilding it
from `_count`/`_offset` would be wrong. `Bundle.total` is never used to decide when to stop.
A server that repeats a next link is detected, and relative links are resolved against the
page they came from.

**Retries** (`src/fhir/client.js`) cover 408, 429, 500, 502, 503, 504 and network failures, with
exponential backoff and equal jitter, bounded at 4 retries. `Retry-After` wins when sent. The
timeout covers reading the body, not just the headers. When HAPI's public server was
unreachable on 2026-09-24, runs failed after five attempts with the cause
(`UND_ERR_CONNECT_TIMEOUT`) and were recorded as failed; the same pulls succeeded on 2026-11-13.

**Idempotency.** Each page is stored in its own transaction: an interrupted run keeps what it
finished, and re-running changes nothing (the first SMART re-run: 1,561 unchanged, 0 versions).

**Incremental sync** pages through `_lastUpdated=ge{cursor}&_sort=_lastUpdated` and advances
`sync_cursors` after each page. It uses `ge`, not `gt`: a crash between two resources that share
a timestamp must not skip the second one. Re-reading a few unchanged resources costs nothing.

**Push** (`src/ingest/push.js`) takes `transaction` Bundles, all-or-nothing in one database
transaction, and `batch` Bundles, per entry. A `urn:uuid` fullUrl becomes the resource id, so
re-sending a bundle updates instead of duplicating. References to it are rewritten, and
`request.ifMatch` is honored (a stale version aborts the transaction).

## Validation

Three layers, one issue shape (`severity`, `category`, `rule`, `element`, `path`, `message`):

1. **JSON Schema** (`src/validation/schema.js`): the HL7 R4 `fhir.schema.json` compiled once by Ajv (about 400 ms, then microseconds per resource). It catches unknown elements (`additionalProperties: false`), arrays vs single values, required-binding `code` values (enums), primitive formats, and missing required *complex* elements. Contained resources are validated one by one against their own type: through the schema's 146-way `oneOf` a single error would be buried in 145 irrelevant failures.
2. **Generated rules** (`src/validation/rules.js`) cover what the schema cannot express:
   - Missing required *primitives*. The schema cannot mark `Observation.status` required, because a primitive may legally be replaced by `_status` carrying an extension.
   - Required bindings on CodeableConcepts, such as `Condition.clinicalStatus`, including the "right code, pre-R4 system URI" mistake.
   - Unknown extensions: a warning, but an error for a *modifier* extension, which changes meaning and cannot be safely ignored.
   - Empty objects and arrays.

   These rules are extracted from `hl7.fhir.r4.core#4.0.1` and `hl7.fhir.us.core#6.1.0` by `npm run rules:build` (30 required primitives, 4 required bindings with expanded value sets, 406 known extensions, Must Support and USCDI elements for 10 profiles). The generated file is committed and reviewable.
3. **Terminology** (`src/validation/terminology.js`) checks every Coding: aliases, missing systems, ICD-10-CM form, LOINC check digits and, against loaded releases, existence, non-billable headers, and deprecated or discouraged status, naming LOINC's replacement. It only asserts that a code *does not exist* when the release covers that code: the system must be loaded in full (`content = complete`) and, for LOINC, the *kind* of code must have been part of the load (`includes`: terms, answers, answer lists, parts). The seed fragments can confirm codes but never deny them.

   That second condition came from a false positive. The first run against full LOINC loaded only `Loinc.csv` and reported the answer code `LA6576-8` ("Positive") as non-existent. Answer codes live in `AnswerList.csv`. Now they load when present, and a load without them says nothing about `LA` codes.

**Which schema.** Three copies of the R4 schema are published on npm or the FHIR registry, and
only one is usable:

- `@medplum/definitions` adds Medplum's own resource types and fields to core definitions (`Meta.project`, `Reference.resource`).
- The per-resource schemas in `hl7.fhir.r4.core` are the legacy draft-04 files without `additionalProperties: false`, so they cannot see unknown elements.
- The copy in `@asymmetrik/fhir-json-schema-validator` was compared property by property with the official 4.0.1 StructureDefinitions. 183 of 185 datatypes and resources are identical. The differences are the `fhirVersion` enum (it predates `4.0.1`) and `valueMeta`, which is missing from the published R4 schema itself; neither touches clinical resources.

**Permissive ingest, strict writes.** Ingest stores whatever a source sends and records its
issues, because measuring non-conformance is the point and rejecting a lab result helps no one.
Single-resource writes through this API must be valid R4 (422 otherwise). Steward overrides
must leave the golden record valid.

**The report** (`src/validation/report.js`) measures each US Core element against the right
denominator:

- **Required** (profile min ≥ 1) elements must always be present.
- **"Populate if known"** (Must Support, USCDI) elements are flagged below 90%.
- **Conditional** elements, which exist only when the situation calls for them (`dataAbsentReason`, `abatement[x]`, `deceased[x]`, blood-pressure `component`), are never findings.
- **Nested** elements are measured among resources that have their parent (`communication.language` among patients with a `communication`).

An early version reported "omits `dataAbsentReason` 100%" as a gap. It was true and meaningless,
and that is why these distinctions exist.

## Terminology

The concept catalog is code (`src/terminology/concepts.js`), not database rows: versioned,
reviewed and unit-tested, with no copy to drift. The database holds only released content
(`codes`, `code_systems`). Loaders replace a system's content atomically in one transaction,
and find LOINC columns by header name, so a release that reorders columns still loads.

A curated catalog drifts as releases change, so `npm run terminology:check` compares it with
whatever release is loaded, and fails on:

- a missing code, or one whose status changed;
- a member whose LOINC example unit its concept cannot convert (such results would come back un-normalized);
- a deprecated or discouraged member whose replacement is not a member.

Run against LOINC 2.83, it caught `33914-3` (MDRD eGFR) discouraged in favor of `77147-7`,
which was not yet in the catalog, and LOINC's own example units (`{counts}/min` for heart rate,
`mL/min` for one eGFR code) that the concepts did not accept.

Matching always normalizes first (`normalizeCoding`), and query-time SQL is deliberately
system-agnostic. The GIN pre-filter matches on the code alone, so a result coded under
`https://loinc.org` or LOINC's OID is still found. The exact system check runs after
normalization in JavaScript.

Units are converted per concept with explicit rules rather than a general UCUM engine: every
conversion a clinician might question (the IFCC→NGSP master equation, molar masses) is in one
reviewable place, and an unknown unit is reported instead of guessed.

**The backlog** (`src/terminology/backlog.js`, `GET /terminology/backlog`) turns "what is not
mapped" from a percentage into a work list: codes that reach no concept, ranked by resources
unlocked and labeled by the kind of work each is (curate it, wait for SNOMED, map a vendor's
local code, or fix it at the source). It is computed from the store on request, not kept as a
side table that ingest has to maintain. SQL groups resources by the set of codings they carry,
so a large store reaches JavaScript as a few hundred distinct code sets. The conformance report
uses the same definition of "reached", including panels mapped through their components.

A system the service recognizes but does not load (WHO ICD-10, ICD-11, RxNorm and the others in
`OTHER_STANDARD_SYSTEMS`) is labeled `unsupported-system`, not `local`. The first version called
anything outside LOINC, ICD-10-CM and SNOMED CT local, which sent the reader to the wrong fix
(a vendor-specific mapping) for a standard terminology; HAPI's WHO ICD-10 Conditions exposed it.
Recognizing a system never aliases it, and the lookup endpoint names it the same way.

## Master patient index

- **Serialized decisions.** Link decisions take a transaction-scoped advisory lock, so two sources delivering the same new person at the same moment cannot each create a golden record.
- **Survivorship is pure** (`src/mpi/survivorship.js`): source records in, `{ golden, conflicts, needsReview }` out. That is why every rule in the README's policy table has a unit test.
- **Golden records are versioned** like resources, with the reason for each version ("linked clinic-b/Patient/... (identifier)", "steward overrides updated"). A recompute that changes nothing mints nothing.
- **Review flags are versioned too.** A golden record's possible duplicates are part of what a steward saw, so adding, moving or dismissing one mints a version and moves the ETag even when the record itself is unchanged. Otherwise a second steward could act on a stale queue without a 412.
- **False merges over duplicates, as the worse failure.** The matching rules were tightened twice against the sandbox data, each time by rebuilding the index (`npm run mpi:rebuild`) and reading what changed:
  1. The first version linked any shared SSN. That merged records of at least two different people who share the "SSN" `56TYRU`. Survivorship caught the birthDate conflict and flagged review, but the charts were already merged. Now trusted identifiers are format-checked, and a match that contradicts birthDate or gender becomes a flagged possible duplicate.
  2. The second version still auto-linked on name and birthDate alone (a score of 0.85 or more), which made 419 links. That is probabilistic matching with nobody checking it. Now demographics only nominate candidates, and an identifier decides. Taking demographic linking away exposed what it had been covering for: 141 of the 142 look-alike groups shared an identifier value, usually an MRN or member id, that the matcher ignored because MRNs mean nothing across organizations. Inside their own namespace they do, so an identifier shared exactly now links when name and birthDate agree as well. The result is 809 people instead of 804: 414 of the 419 links are now backed by an identifier, and the records behind the other five are in a nine-record steward queue (no identifier at all, MRN `123456`, or a name change).
- **What a second real source did to the queue.** Ingesting HAPI (1,013 Patient records, 922 people) grew the steward queue from 9 patients to 136, 127 of them HAPI's. The policy is doing what it should: HAPI's look-alikes are mostly one persona re-uploaded many times, each copy under an identifier of its own, which by name and birthDate alone cannot be told from different people who share both. But the queue is pairwise and `link` moves one record at a time, so the largest group (74 records) is not workable by hand. That is the cost of refusing to link on demographics, and the case for a group-level confirm. No SMART and HAPI patient link or even resemble each other (not one review candidate spans the two), so cross-source reconciliation is still exercised only by the simulated second source.

## Testing

`npm test` runs 97 `node:test` tests against a real, throwaway Postgres (embedded on a free
port, or `TEST_DATABASE_URL`), because JSONB containment, jsonpath, advisory locks and
`FOR UPDATE` are the behavior under test. A mock FHIR server paginates like HAPI (opaque
cursors) and injects 429/503 responses. Terminology fixtures use the exact official release
layouts (the fixed-width CMS order file, LOINC's CSV with quoted commas), so the loaders are
tested against the real formats.

## Decisions not taken

- **Python + FastAPI + `fhir.resources`.** Pydantic validation would have come free, but Node keeps this consistent with the other services; the schema plus generated rules cover the same ground.
- **HAPI FHIR JPA as the store.** It is a complete FHIR server, but the interesting parts here (per-source provenance, conformance measurement, survivorship) would live around it, not in it.
- **Medplum's validator.** It is a strong StructureDefinition-based validator, but it is tied to Medplum's modified definitions. Generating rules from HL7's own packages keeps provenance clean.
- **Flattening to tables.** Deferred on purpose. A projection for analytics (one row per normalized observation fact) can be derived from the JSON later without losing anything; the reverse is not true.

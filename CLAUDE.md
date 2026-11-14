# CLAUDE.md

Context for an agent working in this repository. Read it before changing code.

## What this is

A service that pulls HL7 FHIR R4 resources from several sources (and accepts pushed Bundles),
keeps every version, measures how well each source conforms, maps LOINC and ICD-10-CM codes to
internal concepts, and serves one reconciled patient across sources:

```
GET /patients/{id}/observations?concept=hba1c&since=2024-01-01
```

**Status: working.** `npm test` passes 128 tests against a real Postgres. It has run against
the SMART Health IT sandbox (27,215 resources) and the HAPI public server (6,104 resources),
with LOINC 2.83 and ICD-10-CM FY2026 loaded.
Do not rebuild what is here; extend it.

`README.md` is the user-facing description: setup, API, the conflict-resolution policy and
findings from real data. `ARCHITECTURE.md` holds the reasoning. Both must stay true when
behavior changes, and the numbers in them come from real runs: re-run and update them, never
estimate.

## Stack and commands

Node 22+, ES modules, Express 5, PostgreSQL 14+ through `pg` with raw SQL, Ajv for JSON Schema,
`node:test`. No ORM, no TypeScript, no test framework.

```bash
npm run db:start      # embedded Postgres on :5434, leave it running (or: docker compose up -d)
npm run db:migrate && npm run db:seed
npm run dev           # API on :5051
npm test              # starts its own throwaway Postgres; nothing else needs to be running
npm test -- test/mpi.test.js
```

The database port is 5434, not 5432, to stay clear of a system Postgres. Other scripts
(`ingest`, `report`, `revalidate`, `mpi:rebuild`, `terminology:load`, `terminology:check`,
`rules:build`, `demo:second-source`) document their flags in their header comments.

## Decisions that matter

Do not undo these without understanding why they are here.

**Resources are stored whole, as JSONB.** FHIR is deeply nested and nearly everything is
optional; flattening drops whatever you did not anticipate. The only derived columns are
identity/versioning and a small search index computed at write time (`patient_ref`,
`effective_start`/`effective_end`). Containment queries use the `jsonb_path_ops` GIN index and
are written as explicit `OR`s, not `@> ANY(...)`, so the planner can combine index scans.

**Pagination follows `Bundle.link[relation=next]` verbatim.** The next link is opaque (HAPI's
is a cursor, not an offset). Never rebuild it from `_count`/`_offset`, and never trust
`Bundle.total` to decide when to stop.

**Every write goes through `src/ingest/pipeline.js`.** Pulled, pushed or edited through the
API: store a version, record its validation issues, update the patient index. Do not add a
second write path.

**Two version numbers.** `version_id` is this service's (it backs `meta.versionId` and the
ETag); `source_version_id` is what the source reported. `content_hash` ignores
`meta.versionId/lastUpdated/source`, so a source bumping its version without changing content
mints nothing. History is append-only and deletes are soft.

**Updates are version-aware.** `If-Match` is required (428 without, 412 if stale), checked
under a row lock in the same transaction. Golden records follow the same rule, and changes to
their review flags move the ETag too.

**Ingest is permissive; API writes are strict.** Whatever a source sends is stored with its
issues, because measuring non-conformance is the point. Single-resource writes through this
API must be valid R4 (422).

**Validation is three layers, and its scope is limited.** JSON Schema (structure), rules
generated from the official R4 and US Core packages (required primitives, required bindings,
extensions), and terminology checks. `src/validation/generated/r4-rules.json` is generated:
change `scripts/build-validation-rules.js` and run `npm run rules:build`, never edit the file.
There are no FHIRPath invariants and no profile validation beyond US Core coverage. Do not
describe this as full conformance validation.

**A code "does not exist" only if the loaded release covers it.** See `covers()` in
`src/terminology/service.js`. Seed fragments can confirm a code, never deny one, and a LOINC
load without answer lists says nothing about `LA` codes. This rule exists because of a real
false positive.

**The concept catalog is curated code** (`src/terminology/concepts.js`), with exclusions and
their reasons. Never derive membership by matching names: `86910-7` is an HbA1c *goal*. Run
`npm run terminology:check` after editing it or loading a release, and use
`GET /terminology/backlog` to decide what to add next.

**Normalize before matching.** `normalizeCoding` resolves system aliases, dots ICD-10-CM
codes and checks LOINC check digits (term codes only). Units convert per concept with explicit
rules; an unknown unit is reported, never guessed.

**Recognized is not supported.** `OTHER_STANDARD_SYSTEMS` (`src/terminology/systems.js`) names
standards the service does not load (WHO ICD-10, ICD-10-GM, ICD-11, ICD-9-CM, RxNorm, CPT, NDC,
CVX), so the backlog says `unsupported-system` instead of `local`. Recognizing a system never
aliases it: WHO ICD-10 is not ICD-10-CM, even when the code string exists in both.

**Identity needs a shared identifier.** (`src/mpi/match.js`, policy in the README.) A trusted
person identifier links unless birthDate or gender contradicts it. Any other identifier links
only if it matches exactly *and* name and birthDate agree. Name and birthDate alone never
link: they create review candidates for a steward. A wrong merge puts one person's results in
another person's chart, so when in doubt the answer is a flag, not a link. Link decisions run
under an advisory lock.

**Survivorship is pure and "missing is not a vote".** `src/mpi/survivorship.js` takes source
records and returns `{ golden, conflicts, needsReview }`; every rule in the README's policy
table has a unit test. A source omitting an element never erases another source's value.

**Merging is group-wide, version-checked, and leaves tombstones.** A steward decides about
people, so the unit of work is a group of look-alikes (`src/mpi/groups.js`), and confirming it
needs the group's ETag (a hash of every member's version) as If-Match: any change to the group
is a 412. A merged-away patient keeps its id as a tombstone (`merged_into`, `active: false`, a
`replaced-by` link), developer-API reads of it redirect to the survivor, and steward actions on
it are refused. Records move as manual links with `matched_on.mergedFrom`, so `unlink` can undo
one. `planConfirm` rewires review flags for a subset confirm and is pure; keep it that way.
Dismissing a group (or named patients out of it) is the opposite decision behind the same
ETag guard (`lockedGroup`): it clears flags, merges nothing, and returns the groups that
remain with fresh ETags. Dismissals are not stored.

**Source records are mirrors; stewardship happens on the golden record.** A source's next
version supersedes an edit made here. Overrides, links and dismissals belong to golden records.

**SNOMED CT is out of scope until licensed.** SNOMED-coded data is stored, reported and
returned unmapped. Do not add SNOMED codes to the catalog or fixtures. Licensed releases are
never committed: `data/terminology/` and `.fhir-packages/` are gitignored, and test fixtures
hold a few rows only.

## Layout

```
src/app.js, server.js, config.js, log.js, errors.js
src/db/            schema.sql, migrate.js, seed.js, pool.js
src/fhir/          source client (retries), paginate, dates, references, content hash, presentation
src/ingest/        pull runner, push bundles, the write pipeline, sources
src/store/         versioned resource store
src/validation/    schema (Ajv), generated rules, terminology checks, conformance report
src/terminology/   systems + normalization, concept catalog, units, lookup, backlog, release loaders
src/mpi/           matching, survivorship, golden records, $everything
src/query/         observations and conditions by concept
src/routes/        fhir (versioned facade), patients (developer API), terminology, conformance, ingest
scripts/           CLIs: ingest, report, revalidate, mpi:rebuild, terminology:*, rules:build, dev-db, test
test/              node:test suites, helpers.js, fixtures in the official release file formats
```

## Conventions

- ES modules with `.js` extensions on local imports; `node:` prefix on built-ins.
- Raw SQL, always parameterized. A JSONB parameter that is an array must be `JSON.stringify`d
  (`pg` sends JS arrays as Postgres arrays).
- Throw the helpers in `src/errors.js`. Routes under `/fhir` answer with an OperationOutcome;
  everything else answers `{ error }`.
- Comments say why, not what.
- Every behavior change comes with a test. Tests use a real Postgres through `test/helpers.js`
  (`resetDb`, `startApp`, `mockFhirServer`, fixture builders); do not mock the database.
- Never log resource bodies or demographics.
- Changing matching rules means `npm run mpi:rebuild` on real data and reading what changed
  before updating the docs.

## Deliberate omissions

Tradeoffs, not oversights. Keep them documented rather than quietly half-fixing them.

- No FHIRPath invariants (`con-4` and friends).
- No SMART Backend Services auth toward sources; this API has only an optional shared key.
- Pull ingest pages through FHIR search; there is no Bulk Data `$export` path.
- Matching is rule-based with no probabilistic weighting, and the review queue is an API, not a UI.
- Unit conversion is per concept, not a general UCUM engine.

## Where to take it next

Roughly in order of value:

1. **A review UI, and remembered dismissals.** The queue and its group actions are an API
   only, and a dismissal is not stored, so `npm run mpi:rebuild` raises it again.
2. **A source with real patient overlap.** SMART and HAPI share no patients, so cross-source
   reconciliation has only been exercised on the simulated second source.
3. **Work the terminology backlog.** Six basic-metabolic-panel analytes lead SMART's unmapped
   Observation codes; HAPI's lead with blood-count and liver analytes.
4. **SNOMED CT**, once the UMLS license arrives: an RF2 loader plus `is-a` membership for
   condition concepts. 92.9% of the sandbox's Conditions are SNOMED-only.
5. **FHIRPath invariants** as a fourth validation layer.
6. **Bulk Data ingest** for population-scale pulls.

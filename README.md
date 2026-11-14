# FHIR Integration Service

Ingests HL7 FHIR R4 data from several sources, measures how well each source conforms,
normalizes clinical codes (LOINC, ICD-10-CM) to internal concepts, and serves one reconciled
patient across sources through an API an application developer can actually use:

```
GET /patients/{id}/observations?concept=hba1c&since=2024-01-01
```

returns every HbA1c result for that person from every source, whichever of 9 LOINC codes a
source used, under whichever system URI alias, converted to one unit (IFCC mmol/mol results are
converted to NGSP %), with duplicates that two sources both received collapsed into one.

> **HL7 FHIR R4 ingestion and terminology normalization service (LOINC, ICD-10), with
> conformance validation and resource versioning.**

## What it does

| Phase | What | Key decision |
|---|---|---|
| 1. Ingest | Pulls from FHIR servers (SMART Health IT sandbox, HAPI public server) and accepts pushed transaction/batch Bundles. | Pagination follows `Bundle.link[relation=next]` verbatim. Resources are stored whole as JSONB with a GIN index; nothing is flattened. |
| 2. Validate | Three layers: the HL7 R4 JSON Schema (Ajv), rules generated from the official R4 and US Core StructureDefinitions, and terminology checks. Produces a per-source conformance report. | Nothing hand-written that the spec already defines: the rules are generated from HL7's packages. |
| 3. Terminology | Maps LOINC and ICD-10-CM codes to 33 internal concepts, normalizing system aliases, undotted ICD codes and units along the way. Loads the official LOINC and ICD-10-CM releases. | Scoped to LOINC + ICD-10-CM. SNOMED CT needs a UMLS license (see [Scope](#scope-loinc-and-icd-10-cm-not-snomed-ct)). |
| 4. Query API | `/patients/{id}/observations`, `/conditions`, `/summary`, by concept. | Concept membership is curated and reviewable, not string-matched. |
| 5. Versioning and reconciliation | Every change is a new version (history, vread). ETag / If-Match / If-None-Match semantics. A master patient index links the same person across sources into a golden record, and `$everything` merges them. | Conflicts are recorded, never silently resolved; the policy is [below](#conflict-resolution-policy). |

Design notes and trade-offs are in [ARCHITECTURE.md](ARCHITECTURE.md). [CLAUDE.md](CLAUDE.md)
briefs an AI coding agent on the decisions that should not be undone.

## What the real data showed

Two runs, both validated against LOINC 2.83 and ICD-10-CM FY2026:

- **SMART Health IT R4 sandbox**, 2026-09-24: 27,215 resources (22,296 Observations, 1,990 Conditions, 2,924 Patients). 40 patients with HbA1c results in full, plus incremental syncs of recently updated resources.
- **HAPI public server**, 2026-11-13: 6,104 resources (4,033 Observations, 1,058 Conditions, 1,013 Patients). 40 patients with HbA1c results in full, plus recent syncs.

The first three groups of findings below are SMART's (`npm run report -- --source smart`);
[the last section](#two-sources-side-by-side) compares the two. Both servers are public and
writable, so besides generated test patients they hold whatever other people have posted,
which is where most of the mess is.

**Conformance (US Core 6.1.0 expectations):**

- `Condition.category`, required by US Core, is missing from 94.0% of Conditions.
- `Patient.communication` (preferred language, a USCDI element) is omitted for 26.1% of patients.
- `Observation.specimen` (Must Support on lab results) is never sent, `genderIdentity` never, and the USCDI v3 `sex` extension on 8 of 2,924 patients.
- 73.5% of Patients carry Synthea's own extensions (DALY/QALY), which no IG defines; others carry Epic extensions (`open.epic.com/.../legal-sex`, `template-id`).

**Terminology:**

- 7.9% of Observations code LOINC under `https://loinc.org` instead of `http://loinc.org`; 18 Conditions use the CDC's web page URL as the ICD-10-CM system; one Condition is coded in German ICD-10-GM.
- Observations coded with Epic flowsheet ids and Epic OIDs (`urn:oid:1.2.840.114350...`): local codes with no standard meaning.
- 61 Observations use `12345` as a LOINC code, and 17 carry codes that fail LOINC's Mod 10 check digit (`79968-9`, `59080-0`, ...), so they are not LOINC codes at all. None of them exists in the NLM LOINC index. 9 Observations have no `code` at all.
- 1,712 Observations (7.7%) use codes LOINC 2.83 *discourages*: 986 are the blood-pressure panel `55284-4` and 726 are `33914-3`, an MDRD eGFR. LOINC's replacement for `33914-3` is `77147-7`; both are members of the `egfr` concept, so results map either way.
- 91 Observations use deprecated `21000-5` (red cell distribution width). LOINC replaces it with *two* codes, RDW by coefficient of variation (`115741-1`) and by standard deviation (`115742-9`), so it cannot be remapped automatically: the right one depends on the lab's method.
- 2 Observations answer with `LA28373-2`, which is not a LOINC 2.83 answer code.
- With the FY2026 ICD-10-CM release loaded, 15 Conditions turn out to use category headers, which are not codable diagnoses: `C92.0`, `F01.5`, `F03.9`, `F03.91`, `G20`, `G31.0`, `I25.1`, `M54.4` and `N18.3`. Some were billable codes until later releases subdivided them: `N18.3` (CKD stage 3) is now `N18.30` (unspecified), `N18.31` (stage 3a) and `N18.32` (stage 3b). That is code-set drift: older data validated against the current release. Another 7 Conditions use `C95.80`, which does not exist in ICD-10-CM.
- 92.9% of Conditions are coded only in SNOMED CT, so they cannot be mapped until SNOMED is licensed. That number is the case for the UMLS application.

**Identity:**

- The 2,924 Patient records resolve to 809 people. 1,702 links rest on a trusted person identifier: Synthea patients re-uploaded with the same SSN, and eleven demo patients each posted 14 or 15 times with the same NHS number. Another 414 rest on an MRN or member id shared inside its own namespace *and* agreeing name and birthDate: the same test patient posted up to four times.
- No link rests on name and birthDate alone. Nine records are left for a steward instead: four identical "John Doe, 1990-01-01" records with no identifier at all; three "Jane Smith-First" records whose only identifier is MRN `123456` in a made-up namespace, which is too generic to be evidence; and two that share an identifier and a birthDate under different family names, which is what a name change looks like.
- Four Patient records share the "SSN" `56TYRU`, next to an unrendered template placeholder `{{patient_drivers_license}}`. They belong to at least two different people (born 1980 and 1990), and a naive SSN match merged all four into one chart. That is why trusted identifiers are format-checked and why an identifier match that contradicts birthDate or gender is flagged, not linked (see [Matching](#matching)). Today they resolve to three people: the two records with the same MRN, name and birthDate are one, and the other two are the name-change pair above.

### Two sources side by side

Sources differ, and absorbing that is what the service exists for. Share of resources that
populate each element, from the stored data:

| | SMART | HAPI |
|---|---|---|
| Patient.name | 100% | 78.8% |
| Patient.telecom | 90.6% | 7.8% |
| Patient.address | 91.1% | 5.6% |
| Patient.communication | 73.9% | 1.6% |
| Patient race extension | 91.3% | 3.9% |
| Patient ethnicity extension | 91.2% | 0.2% |
| Condition.onset[x] | 99.8% | 52.4% |
| Condition.verificationStatus | 99.9% | 78.8% |
| Condition.encounter | 93.0% | 37.3% |
| Condition.category | 6.0% | 33.2% |
| Observation.encounter | 89.9% | 0.0% |
| Observation.referenceRange | 4.7% | 0.1% |
| Observation.code as plain `http://loinc.org` | 91.2% | 100% |
| Numeric Observations with a UCUM-coded unit | 95.9% | 99.9% |
| Observation.code mapped to a concept | 50.2% | 37.9% |
| Conditions coded only in SNOMED CT | 92.9% | 75.7% |

So "HAPI omits `Patient.communication` for 98.4% of patients, SMART for 26.1%" is something the
report produces per source, not an estimate. `GET /conformance` lists every source side by side.

- HAPI's Conditions use SNOMED CT through its OID (2.6%, normalized), WHO ICD-10 (1.2%), ICD-11 (0.2%) and an invented `chartr.example` system (7%). WHO ICD-10 codes such as `I10` are reported as `unsupported-system` and never read as ICD-10-CM. HAPI's few outright errors are Conditions whose `clinicalStatus` has the right code but no system (8) and Conditions with no `subject` (3).
- HAPI's 1,013 Patient records resolve to 922 people, and none of them is linked to a SMART patient or even resembles one: no review candidate spans the two. The servers hold different populations, so reconciliation across sources is still demonstrated only with the simulated second source (`npm run demo:second-source`).
- 127 HAPI patients (192 source records, in 21 groups of connected look-alikes) are in the steward queue, against 9 patients in 3 groups for SMART. For 121 of them the reason is look-alikes with no identifier in common: mostly one persona re-uploaded many times, each copy with an identifier of its own, so name and birthDate are all there is and the policy leaves them for a steward. The largest group is 74 records in 18 patients. A group is one call to confirm (see [Matching](#matching)); in a dry run that was rolled back, that group took 16 ms and all 24 groups took 85 ms. Two of the 24 are chains rather than cliques. In the one with 26 patients a single patient accounts for every missing pair, so dismissing that one patient leaves a complete group of 25 to confirm, which is why a group reports whether it is `complete` and both actions can name a subset. Dismissing all 24 groups in the same kind of dry run took 92 ms and changed no patient or record.

These are snapshots. HAPI's numbers come from a smaller sample, and its Observations lean on one
cohort: the 40 HbA1c patients supply 1,178 of the 4,033. The server is shared and everything on
it was written on or after 2026-09-25, so a rerun will differ. The first attempt, on 2026-09-24,
found HAPI timing out on every connection: ingest retried with backoff and recorded each run as
failed with its cause (`GET /ingest/runs`), and the 2026-11-13 attempt succeeded.

## Tech stack

- Node.js 22+ and Express 5 (ESM), PostgreSQL 14+ via `pg` (raw SQL, no ORM)
- Ajv 8 with the HL7 FHIR R4 JSON Schema
- Rules generated from `hl7.fhir.r4.core#4.0.1` and `hl7.fhir.us.core#6.1.0`
- `node:test` against a real Postgres (embedded, so no Docker is required)

## Local setup

### 1. Install and configure

```bash
cp .env.example .env
```

```bash
npm install
```

### 2. Start Postgres

Any Postgres 14+ works; point `DATABASE_URL` in `.env` at it. The default is port 5434, not
5432, so it does not collide with a system Postgres (or a Docker one) you may already run.
Without Docker, run the embedded Postgres in its own terminal (data lives in `.pgdata/`):

```bash
npm run db:start
```

Or with Docker:

```bash
docker compose up -d
```

### 3. Create the schema and seed

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

The seed registers the sources (`smart`, `hapi`, and `clinic-b`, a push-only source) and
terminology fragments: the catalog's LOINC codes and the 441 billable ICD-10-CM codes under its
category roots, so lookups work before the full releases are loaded.

### 4. Run it

```bash
npm run dev
```

The API listens on `http://localhost:5051` (not 5050, which the Clinic Ops Dashboard API uses, so both can run at once).

### 5. Ingest, reconcile, report

Pull 25 SMART patients who have an HbA1c result, with their Observations and Conditions:

```bash
npm run ingest -- --source smart --patients 25 --has-code "http://loinc.org|4548-4"
```

The same pull from the HAPI public server:

```bash
npm run ingest -- --source hapi --patients 40 --has-code "http://loinc.org|4548-4"
```

Incrementally sync one resource type from its `_lastUpdated` high-water mark:

```bash
npm run ingest -- --source smart --sync Condition --since 2023-01-01 --max-pages 25
```

Simulate a second EHR that knows one of those patients (same SSN spelled differently, a middle
name, a newer address, HbA1c in IFCC units, type 2 diabetes as an undotted ICD-10-CM code, and
one lab result both EHRs received), pushed as a FHIR transaction:

```bash
npm run demo:second-source -- --name gerlach
```

Print a source's conformance report:

```bash
npm run report -- --source smart
```

### Tests

```bash
npm test
```

128 tests. They start a throwaway embedded Postgres on a free port (or use `TEST_DATABASE_URL`)
and a mock FHIR server that paginates with opaque `_getpages` cursors and injects 429/503s.

## API

Examples assume `http://localhost:5051`. When `API_KEY` is set, send `Authorization: Bearer <key>`.

### Developer API: one patient, by concept

| Method | Path | |
|---|---|---|
| GET | `/patients?name=&source=&needsReview=&multiSource=` | Golden patients. `needsReview=true` is the steward's queue. |
| GET | `/patients/{id}` | Golden record, linked source records, conflicts, possible duplicates. Returns `ETag`. |
| GET | `/patients/{id}/observations?concept=hba1c,glucose&since=&until=&limit=` | Normalized results across sources |
| GET | `/patients/{id}/conditions?concept=&status=active&since=` | Conditions by concept; unmapped (SNOMED-only) ones included and counted |
| GET | `/patients/{id}/summary` | Latest value per concept, active conditions |
| GET | `/patients/{id}/$everything` | FHIR Bundle merged across sources |
| GET | `/patients/{id}/history` | Golden record versions and why each changed |
| PUT | `/patients/{id}/overrides` | Steward pins element values. Requires `If-Match`. |
| POST | `/patients/{id}/link`, `/unlink` | Confirm a possible duplicate, or undo a wrong link: `{ "source", "fhirId" }`. Requires `If-Match`. |
| POST | `/patients/{id}/dismiss-duplicates` | Not the same person after all: `{ "patient": "<id>" }` settles one candidate, no body settles all. Requires `If-Match`. |
| GET | `/patients/duplicate-groups?source=&limit=&offset=` | Groups of look-alike patients (connected by review flags), biggest first. Each has an `etag` and says whether every pair is flagged (`complete`). |
| GET | `/patients/duplicate-groups/{id}` | One group; `id` can be any member. Returns the group's `ETag`. |
| POST | `/patients/duplicate-groups/{id}/confirm` | Confirm a group as one person. `If-Match` is the group's ETag. Optional body: `{ "patients": [...], "survivor": "<id>" }`. |
| POST | `/patients/duplicate-groups/{id}/dismiss` | Not the same people after all: dismisses the whole group, or only the patients named in `patients` (they lose every flag; the rest stay flagged among themselves). `If-Match` is the group's ETag. Returns the groups that remain, with fresh ETags. |

An observation in the response:

```json
{
  "id": "clinic-b/Observation/9e8d5e1d-d073-5d90-ad2d-51cba964620b",
  "source": "clinic-b",
  "concept": "hba1c",
  "code": { "system": "http://loinc.org", "code": "59261-8", "display": "HbA1c (IFCC)" },
  "effective": "2026-08-15T16:30:00.000Z",
  "status": "final",
  "value": 7.5,
  "unit": "%",
  "original": { "value": 58, "unit": "mmol/mol" },
  "conversion": "IFCC mmol/mol → NGSP % (NGSP = 0.09148 × IFCC + 2.152)"
}
```

That result arrived under `urn:oid:2.16.840.1.113883.6.1` (LOINC's OID) and is returned under the
canonical system. A result both sources received appears once, with `alsoReportedBy` naming the
other copies.

### Terminology

| Method | Path | |
|---|---|---|
| GET | `/terminology/lookup?system=loinc&code=17856-6` | Canonical form, release data, and the internal concept(s) a code maps to, or why it is excluded |
| GET | `/concepts?domain=observation`, `/concepts/{id}` | The catalog: members, exclusions, accepted units and conversions |
| GET | `/terminology/backlog?resourceType=Observation&source=&kind=&limit=` | Codes that reach no concept, ranked by how many resources each would unlock (see [Backlog](#backlog)) |
| GET | `/terminology/systems` | What is loaded: `fragment` (seed) or `complete` (a release) |

`system` accepts `loinc`, `icd10cm`, `snomed`, a canonical URI or an alias. Looking up `41995-2`
explains that it is excluded from `hba1c` (a mass concentration in g/dL, not a fraction of
total hemoglobin). Looking up `E1165` under the CDC's URI normalizes it to `E11.65` and maps it
to `type-2-diabetes`.

### Conformance

| Method | Path | |
|---|---|---|
| GET | `/conformance` | Every source side by side: counts, resources with errors, top findings |
| GET | `/conformance/{source}` | Full report: findings, issues by category/rule/element, US Core coverage, terminology coverage |
| POST | `/validate` | Validate any resource; `?format=outcome` answers with an OperationOutcome |

Issue categories: `missing-required`, `cardinality`, `invalid-code`, `unknown-extension`, plus
`unknown-element` and `invalid-value` for structural problems that are neither.

### FHIR facade (versioned)

Each source has its own FHIR base, `/fhir/{source}`; golden patients live under `/fhir/golden`.

| Method | Path | |
|---|---|---|
| GET | `/fhir/{source}/{type}/{id}` | Read. `ETag: W/"n"`, `Last-Modified`; `If-None-Match` answers 304; deleted answers 410 |
| GET | `/fhir/{source}/{type}/{id}/_history[/{vid}]` | Every version, or one |
| PUT | `/fhir/{source}/{type}/{id}` | Version-aware update: `If-Match` required (428 without, 412 if stale); body must be valid R4 (422) |
| DELETE | `/fhir/{source}/{type}/{id}` | Soft delete, `If-Match` required |
| POST | `/fhir/{source}` | Push a `transaction` (all-or-nothing) or `batch` Bundle; honors `request.ifMatch` |
| GET | `/fhir/golden/Patient/{id}[/$everything \| /_history]` | Golden records as FHIR |

`meta.versionId` on this API is the service's own version; `meta.source` names the exact source
version it came from, e.g. `https://r4.smarthealthit.org/Observation/d88d.../_history/4`.

### Ingest control

| Method | Path | |
|---|---|---|
| POST | `/ingest/runs` | Start a pull in the background: `{ "source": "smart", "patients": 25, "hasCode": "http://loinc.org\|4548-4" }` or `{ "source": "smart", "sync": "Observation" }`. Answers 202. |
| GET | `/ingest/runs[/{id}]` | Progress and outcome of runs |
| GET | `/sources` | Configured sources |

## Terminology

### Concepts

`src/terminology/concepts.js` defines 18 observation concepts (HbA1c, glucose, fasting glucose,
lipids, creatinine, eGFR, urine ACR, vitals) and 15 condition concepts (type 1 and 2 diabetes,
prediabetes, hypertension, hyperlipidemia, CKD, asthma, COPD, heart failure, atrial fibrillation,
ischemic heart disease, depression, obesity, dementia, hypothyroidism).

Membership is curated rather than derived from LOINC names, because the near misses are
clinically wrong. `86910-7` is an HbA1c *goal*. `41995-2` is HbA1c mass concentration. ICD-10-CM
`E66.3` is overweight, not obesity. `I48.3` is atrial flutter, not fibrillation. `E78.6` is
lipoprotein *deficiency*. Each exclusion is recorded with its reason, so a lookup can explain
itself.

The catalog is checked against the loaded releases with `npm run terminology:check`:

- every code exists, with the status the release gives it;
- every member's LOINC example unit is one its concept can convert;
- a deprecated or discouraged member's replacement is also a member;
- every ICD-10-CM root is in the release.

The last run passed for 109 LOINC entries against 2.83 and 45 ICD-10-CM entries against FY2026.
`--suggest` lists release codes that share a member's LOINC component and specimen but are not
in the catalog. That is how LOINC 2.83 extended it: molar and mass pairs, venous, arterial and
dried-blood-spot specimens, and `77147-7`, LOINC's replacement for the MDRD eGFR code it now
discourages. It also gave evidence for earlier calls: LOINC maps deprecated `55454-3`
"Hemoglobin A1c in Blood" to the mass-concentration code `41995-2`, which is excluded from
`hba1c`.

eGFR covers every equation normalized to 1.73 m²: creatinine, cystatin C or both, adult and
pediatric. Race-based equations are members (legacy feeds still send them) and are labeled as
such; CKD-EPI 2021 (`98979-8`, and `98980-6` with cystatin C) is the current race-free
equation.

Normalization, before matching:

- System aliases resolve to canonical URIs: `urn:oid:2.16.840.1.113883.6.1`, `https://loinc.org` and `http://www.cdc.gov/nchs/icd/icd10cm.htm` all become the canonical system. WHO ICD-10 (`http://hl7.org/fhir/sid/icd-10`) is deliberately *not* treated as ICD-10-CM.
- ICD-10-CM codes are dotted (`E119` becomes `E11.9`) and upper-cased.
- LOINC term codes are checked against LOINC's Mod 10 check digit.
- Units map to UCUM, then to the concept's unit with an explicit, per-concept conversion (IFCC→NGSP master equation, mmol/L→mg/dL with the analyte's molar mass, °F→°C, lb→kg). An unconvertible unit is reported, never guessed.

### Loading the releases

The seed fragments make everything work, but only a full release lets validation say a code
*does not exist*, or that `C92.0` is a non-billable category header. The findings above come
from LOINC 2.83 and ICD-10-CM FY2026. Each loads in seconds, and revalidating the 27,215 stored
resources takes about two. Keep licensed downloads out of the repository (`data/terminology/`
is gitignored for the purpose).

- **LOINC**: download the release from [loinc.org/downloads](https://loinc.org/downloads/) (free, account required) and point the loader at the unzipped folder. It loads `LoincTable/Loinc.csv` (terms), `LoincTable/MapTo.csv` (replacements for deprecated and discouraged terms), and, when present, `AccessoryFiles/AnswerFile/AnswerList.csv` (answer codes `LA...` and answer lists `LL...`) and `AccessoryFiles/PartFile/Part.csv` (parts `LP...`). LOINC 2.83 is 214,712 codes in all.
- **ICD-10-CM**: from [CMS](https://www.cms.gov/medicare/coding-billing/icd-10-codes), download the fiscal-year "Code Descriptions in Tabular Order" and use `icd10cm_order_YYYY.txt`. It includes the category headers (23,467 of FY2026's 98,186 entries); the billable-only `icd10cm_codes_YYYY.txt` also works.

```bash
npm run terminology:load -- --loinc ~/Downloads/Loinc_2.83
```

```bash
npm run terminology:load -- --icd10cm data/terminology/icd10cm-2026/icd10cm_order_2026.txt
```

Issues are recorded when data is written, so re-check what is already stored:

```bash
npm run revalidate
```

Then check the concept catalog against the new release:

```bash
npm run terminology:check
```

Validation only calls a code non-existent when the release covers that *kind* of code. A
terms-only LOINC load says nothing about answer codes. Before answer lists were loaded, the
first full-LOINC run flagged `LA6576-8` ("Positive") as unknown, which was false.

### Backlog

`GET /terminology/backlog` is the catalog's to-do list, read off the stored data: every code
that reaches no concept, ranked by how many resources it would unlock. A resource counts as
reached through its own code or, for a panel, a component's: a blood-pressure panel is mapped
by its systolic and diastolic components. Each entry says what kind of work it is:

| `kind` | Meaning | What to do |
|---|---|---|
| `unmapped` | A valid code with no concept | Add it to a concept, or write a new one |
| `unsupported-system` | A standard terminology that is not loaded: SNOMED CT, WHO ICD-10, ICD-10-GM, ICD-11, ICD-9-CM, RxNorm, CPT, NDC, CVX | SNOMED CT needs a UMLS license; the others need a loader and a mapping |
| `local` | Not a standard terminology, such as an Epic flowsheet id | Needs a mapping specific to that source |
| `invalid` | Malformed, or not in the loaded release | Fix at the source; do not map |
| `excluded` | Deliberately left out of a concept | Nothing; the entry gives the reason |
| `no-system` | A code with no system | Fix at the source |

On the sandbox data, 49.8% of Observations reach no concept, and the list says what to curate
next. Six of the eight analytes in a basic metabolic panel (chloride, CO2, sodium, calcium,
potassium, urea nitrogen) account for about 934 results each; glucose and creatinine, the other
two, are already concepts. Pain score and smoking status follow. For Conditions, 118 of the
unmapped codes are SNOMED CT, and four of the most frequent are concepts the catalog already
has under ICD-10-CM: prediabetes (91 Conditions), hypertension (73), obesity (71) and
hyperlipidemia (43). HAPI's list is different: its Observations lead with blood-count and liver
analytes (platelets, globulin, ALT, albumin, AST, about 139 results each), and its Conditions
with SNOMED stroke and myocardial infarction.

### Scope: LOINC and ICD-10-CM, not SNOMED CT

SNOMED CT content requires a UMLS license: free for US users, but approval takes days. This
build is scoped to LOINC and ICD-10-CM, deliberately. SNOMED-coded data is still stored,
validated and reported. `lookup` says SNOMED is unsupported and why, the conditions API
returns SNOMED-only conditions marked unmapped rather than dropping them, and the conformance
report counts them (92.9% of the sandbox's Conditions). Adding SNOMED means a loader for the
RF2 description snapshot plus `is-a` membership for condition concepts. Nothing else changes.

Other standard terminologies (WHO ICD-10, ICD-10-GM, ICD-11, ICD-9-CM, RxNorm, CPT, NDC, CVX)
are recognized and named in the backlog and in lookups, but not loaded or mapped. A WHO ICD-10
code is never read as ICD-10-CM, even when the string exists in both: HAPI sends both kinds, and
the backlog calls the first one what it is.

## Conflict-resolution policy

### Matching

Identity needs a shared identifier. A source Patient is linked to an existing person by, in
order:

1. **A trusted person identifier.** US SSN (under either `http://hl7.org/fhir/sid/us-ssn` or the SSN OID, dashes ignored), UK NHS number, or Synthea's person id. The value must be well formed (an SSN is nine digits) and must not be a placeholder (`999-99-9999`, `123456789`, `{{template}}`).
   **Unless identity is contradicted.** A shared identifier with a different full birthDate, or a different gender, is more likely a reused or mistyped identifier than one person. The record gets its own golden record and both are flagged for a steward.
2. **Any other identifier shared exactly, with agreeing demographics.** An MRN or a member id means something only inside the namespace that issued it. So the system URI and the value must both match, the value must be specific enough to be evidence (`12345`, `test1` and `{{template}}` are not), *and* name and birthDate must agree (a demographic score of 0.85 or more, below). An MRN alone links nothing: namespaces get reused, and across organizations an MRN means nothing.
3. Otherwise the record becomes a new person.

**Name and birthDate alone never link.** Two people can share both, and probabilistic matching
with no human in the loop is how two patients' results end up in one chart. That is a
patient-safety event, not a data-quality one, and a duplicate record is the cheaper mistake.
Records that only resemble an existing person become review candidates instead
(`possibleDuplicates`, recorded on both golden records). So do records that share an identifier
and a birthDate under a different name: a name change, or a reused identifier.

The demographic score: among Patients with the same birthDate (the blocking key), gender must
agree. Names are compared with Jaro-Winkler: family 0.5 if exact, 0.35 if typo-level; given
0.4 if exact, 0.25 for a nickname or initial. A matching postal code or phone adds 0.1 each.

Links are sticky: a later change to a linked record is re-survived, not re-matched. A steward
works the queue (`GET /patients?needsReview=true`) with three actions:

- `link` confirms a candidate: its record joins this patient, and any other open candidates follow it.
- `dismiss-duplicates` says they are different people, for one candidate or all.
- `unlink` undoes a wrong link.

Each requires If-Match, and each moves the patient's ETag, so two stewards cannot act on the
same stale view.

Look-alikes come in groups, so there is a group view too. `GET /patients/duplicate-groups`
returns each group (patients connected by review flags) with an ETag covering every member's
version, and says whether every pair is flagged (`complete`). A chain, where A resembles B and B
resembles C but A does not resemble C, is a group but not complete, and deserves a closer look.
`POST /patients/duplicate-groups/{id}/confirm` merges the whole group into one patient in a
single call, or only the patients named in `patients` (the rest stay flagged against the merged
patient). It needs `If-Match` with the group's ETag, so it only works on the view the steward
read: a member edited, added or removed since then is a 412.

The oldest patient keeps its id (or name another with `survivor`). The others become tombstones:
inactive, with a `replaced-by` link in their FHIR record, and reads of their ids through the
developer API redirect (301) to the survivor, so ids that applications stored keep working;
steward actions on them are refused (409). Their records move as `manual` links that remember
where they came from (`matched_on.mergedFrom`), so `unlink` can still split one back out. Values
a steward pinned on a merged-away patient are not carried over (they stay in its history); the
response lists them as `overridesDropped`.

Dismissing is the opposite decision. `POST /patients/duplicate-groups/{id}/dismiss` says the
group's patients are different people: all of them, or only the ones named in `patients`, who
lose every flag while the rest stay flagged among themselves. That is how a mixed group is
worked: dismiss the odd one out, then confirm what is left. The response returns the groups
that remain, each with a fresh ETag, so nothing has to be read again in between, and it lists
any dismissed patient that still needs review for another reason (a conflict between its own
records). Nothing merges and no record moves. A dismissed pair stays dismissed when a new
look-alike arrives (only the newcomer is flagged), but dismissals are not stored:
`npm run mpi:rebuild` raises them again.

### Survivorship

The golden record is rebuilt from its linked source records whenever one changes. Records are
ranked by **most recently updated** (the source's `meta.lastUpdated`; a push without one is
dated by its arrival), then by **source priority** (`clinic-b` 10, `smart` 20, `hapi` 30; lower
wins), then by id, for determinism.

**Missing is not a vote.** A source that omits an element never erases another source's value.
That matters because omission is exactly what the conformance report shows sources doing.

| Element | Rule | Disagreement is |
|---|---|---|
| `identifier` | Union, deduplicated (SSN normalized across spellings) | **high** if two different SSNs |
| `name` | Union; the best-ranked source's official name first | normal |
| `telecom` | Union, deduplicated by normalized value (digits for phones) | normal, if the same system and use carry different values |
| `gender` | Best-ranked source | **high** |
| `birthDate` | The most precise value consistent with all sources: `1954` and `1954-01-20` agree | **high** if contradictory |
| `deceased[x]` | A death asserted by any source wins over silence or an older "alive"; a false "alive" is the worse error. A dated assertion is preferred. | **high** if alive vs dead |
| `address` | The best-ranked source's addresses are current; different addresses from other sources are kept with `use: old`. People move. | normal |
| `maritalStatus`, `multipleBirth[x]` | Best-ranked source | normal |
| `communication` | Union by language | none |
| `extension` | One per URL (race, ethnicity, birth sex...), best-ranked source | normal |
| `generalPractitioner`, `managingOrganization`, `link` | Dropped: they point into one source's id space. The golden record links to its sources with `Patient.link` (`type: seealso`). | none |

Every disagreement is recorded in `conflicts` with all candidate values, their sources and
timestamps, the value kept and the rule that kept it. A record **needs review** while it has an
unresolved high-severity conflict or a possible duplicate. **Steward overrides**
(`PUT /patients/{id}/overrides`) are applied last, must leave the golden record valid R4, and mark
the conflicts they settle as resolved. Every change mints a new golden version with its reason
(`GET /patients/{id}/history`).

### `$everything` and clinical duplicates

`$everything` returns the golden Patient plus every resource in each linked source's patient
compartment. Patient references are rewritten to the golden Patient. Each entry's `fullUrl` is
its source-scoped URL here, so its other relative references (`Encounter/123`) still resolve
within the right source.

The same clinical fact from two sources appears once. Two resources are the same fact when
they share a business identifier, or, for results and problems without one:

- an Observation with the same code, effective minute and value;
- a Condition with the same code and onset day.

The copy from the best-ranked record is kept. The query API does the same, on normalized
values, so `5.9 %` and `41 mmol/mol` from the same draw collapse too, and lists the other copies
in `alsoReportedBy`. A final OperationOutcome entry (`search.mode: outcome`) reports per-source
counts, the duplicates removed and each demographic conflict.

### Source records vs golden records

A source's own records are mirrored, versioned copies: the source is the truth for them, and
its next version supersedes any edit made through this API (the edit remains in history).
Stewardship belongs on the golden record, through overrides and links.

## Project structure

```
fhir-integration-service/
├── src/
│   ├── app.js, server.js, config.js, log.js, errors.js
│   ├── db/            schema.sql, migrate.js, seed.js, pool.js
│   ├── fhir/          client (retries), paginate, dates, references, content hash, presentation
│   ├── ingest/        pull runner, push bundles, write pipeline, sources
│   ├── store/         versioned resource store
│   ├── validation/    schema (Ajv), generated rules, terminology checks, conformance report
│   ├── terminology/   systems + normalization, concept catalog, units, lookup, backlog, release loaders
│   ├── mpi/           matching, survivorship, golden records, review groups, $everything
│   ├── query/         observations and conditions by concept
│   ├── routes/        fhir, patients, terminology, conformance, ingest
│   └── middleware/    API key, errors
├── scripts/           ingest, report, revalidate, mpi:rebuild, terminology:load,
│                      terminology:check, rules:build, demo:second-source, dev-db, test
└── test/              128 tests + fixtures in the official release file formats
```

## Limitations and next steps

- **SNOMED CT**: see [Scope](#scope-loinc-and-icd-10-cm-not-snomed-ct).
- **FHIRPath invariants** (e.g. `con-4`: abatement implies an inactive clinicalStatus) are not evaluated; the next validation layer would run them with the official FHIRPath engine.
- **Auth to real EHRs**: the sandboxes are open. A production source would need SMART Backend Services (client-credentials JWT); this service's own API has only an optional shared key.
- **Scale**: patient-level pulls page through FHIR search. Population-scale ingest should use Bulk Data `$export`.
- **Units**: conversions are concept-scoped and explicit, not a general UCUM engine.
- **Matching** is rule-based, with no Fellegi-Sunter weighting, and the review queue is an API, not a UI. Dismissals are not stored: `npm run mpi:rebuild` regenerates golden ids and raises candidates a steward had dismissed again, and refuses to run over manual links (every confirm creates them) unless given `--force`.
- **Cross-source reconciliation on real overlap** has not been exercised. SMART and HAPI share no patients, so it is demonstrated with a simulated second source.

---

This material contains content from LOINC® (http://loinc.org). LOINC is copyright © Regenstrief
Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and is
available at no cost under the license at http://loinc.org/license. ICD-10-CM is a US government
work in the public domain. FHIR® is the registered trademark of HL7.

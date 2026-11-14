-- FHIR Integration Service schema (PostgreSQL 14+)
--
-- Resources are stored whole, as JSONB, exactly as the source sent them. The only columns
-- derived from the JSON are identity/versioning metadata and a small search index
-- (patient_ref, effective_start/effective_end) computed at write time; nothing is
-- decomposed into per-element tables.

-- ---------------------------------------------------------------------------
-- Sources and ingested resources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,                      -- 'smart', 'hapi', 'clinic-b'
  name TEXT NOT NULL,
  base_url TEXT,                            -- NULL for push-only sources
  kind TEXT NOT NULL CHECK (kind IN ('pull', 'push')),
  priority INTEGER NOT NULL DEFAULT 100,    -- survivorship tie-breaker: lower wins
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  mode TEXT NOT NULL,                       -- 'patients' | 'sync' | 'push'
  params JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  pages INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,       -- resources seen for the first time
  updated INTEGER NOT NULL DEFAULT 0,       -- resources that got a new version
  unchanged INTEGER NOT NULL DEFAULT 0,
  with_errors INTEGER NOT NULL DEFAULT 0,   -- new versions carrying error-severity issues
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS resources (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  resource_type TEXT NOT NULL,
  fhir_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,              -- local version: ETag W/"n", meta.versionId on our API
  source_version_id TEXT,                   -- meta.versionId as reported by the source
  last_updated TIMESTAMPTZ,                 -- meta.lastUpdated as reported by the source
  content_hash TEXT NOT NULL,               -- sha256 of canonical JSON, meta excluded
  deleted BOOLEAN NOT NULL DEFAULT false,
  patient_ref TEXT,                         -- 'Patient/<id>' in the source's id space (compartment index)
  effective_start TIMESTAMPTZ,              -- clinically relevant time range (search index)
  effective_end TIMESTAMPTZ,
  resource JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, resource_type, fhir_id)
);

-- jsonb_path_ops: smaller and faster than the default opclass; supports @>, @? and @@.
CREATE INDEX IF NOT EXISTS idx_resources_jsonb ON resources USING GIN (resource jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_resources_compartment ON resources (source_id, patient_ref, resource_type);
CREATE INDEX IF NOT EXISTS idx_resources_type_updated ON resources (resource_type, last_updated);

-- Append-only history: every version of every resource, never overwritten.
CREATE TABLE IF NOT EXISTS resource_versions (
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL,
  source_version_id TEXT,
  last_updated TIMESTAMPTZ,
  content_hash TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  change_origin TEXT NOT NULL CHECK (change_origin IN ('ingest', 'push', 'api')),
  ingest_run_id BIGINT REFERENCES ingest_runs(id) ON DELETE SET NULL,
  resource JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, version_id)
);

-- High-water marks for incremental (_lastUpdated) sync.
CREATE TABLE IF NOT EXISTS sync_cursors (
  source_id TEXT NOT NULL REFERENCES sources(id),
  resource_type TEXT NOT NULL,
  last_updated TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, resource_type)
);

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS validation_issues (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'information')),
  category TEXT NOT NULL,                   -- missing-required | cardinality | invalid-code | unknown-extension | unknown-element | invalid-value
  rule TEXT NOT NULL,                       -- stable key for aggregation, e.g. 'required-binding'
  element TEXT NOT NULL,                    -- path without indices, e.g. 'Condition.clinicalStatus'
  path TEXT NOT NULL,                       -- exact location, e.g. 'Condition.code.coding[1].system'
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_validation_issues_resource ON validation_issues (resource_id, version_id);

-- ---------------------------------------------------------------------------
-- Terminology
--
-- Only released code system content lives here (LOINC, ICD-10-CM). The canonical
-- concept catalog that maps those codes to internal concepts is code
-- (src/terminology/concepts.js): versioned, reviewed and unit tested like the rest.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS code_systems (
  url TEXT PRIMARY KEY,                     -- canonical system URI, e.g. 'http://loinc.org'
  name TEXT NOT NULL,
  version TEXT,
  content TEXT NOT NULL CHECK (content IN ('complete', 'fragment', 'not-present')),  -- FHIR CodeSystem.content
  includes TEXT[] NOT NULL DEFAULT '{}',    -- kinds of code a 'complete' release covers, e.g. LOINC terms, answers, parts
  source TEXT,                              -- file the release was loaded from, or 'seed'
  code_count INTEGER NOT NULL DEFAULT 0,
  loaded_at TIMESTAMPTZ
);

ALTER TABLE code_systems ADD COLUMN IF NOT EXISTS includes TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS codes (
  system TEXT NOT NULL REFERENCES code_systems(url),
  code TEXT NOT NULL,
  display TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- active | deprecated | discouraged | trial | header
  properties JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (system, code)
);

-- ---------------------------------------------------------------------------
-- Master patient index / reconciliation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS master_patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id INTEGER NOT NULL DEFAULT 1,
  golden JSONB NOT NULL,                    -- computed FHIR Patient (survivorship + overrides)
  overrides JSONB NOT NULL DEFAULT '{}',    -- steward-pinned element values
  conflicts JSONB NOT NULL DEFAULT '[]',    -- conflicts found by the last survivorship pass
  possible_duplicates JSONB NOT NULL DEFAULT '[]', -- masters a steward should compare: similar demographics, or a shared identifier that contradicts
  needs_review BOOLEAN NOT NULL DEFAULT false,
  merged_into UUID REFERENCES master_patients(id), -- set once every source record has moved to another patient: this id is then a tombstone that points there
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added after the first release; keeps existing databases migratable.
ALTER TABLE master_patients ADD COLUMN IF NOT EXISTS possible_duplicates JSONB NOT NULL DEFAULT '[]';
ALTER TABLE master_patients ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES master_patients(id);

CREATE TABLE IF NOT EXISTS master_patient_versions (
  master_id UUID NOT NULL REFERENCES master_patients(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL,
  golden JSONB NOT NULL,
  overrides JSONB NOT NULL,
  conflicts JSONB NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (master_id, version_id)
);

-- Each source Patient row belongs to exactly one master patient.
CREATE TABLE IF NOT EXISTS patient_links (
  resource_id BIGINT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  master_id UUID NOT NULL REFERENCES master_patients(id) ON DELETE CASCADE,
  method TEXT NOT NULL,                     -- 'new' | 'identifier' | 'identifier+demographics' | 'manual'
  score NUMERIC(4, 3),
  matched_on JSONB,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_patient_links_master ON patient_links (master_id);

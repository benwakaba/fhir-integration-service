import { Router } from 'express';
import pool from '../db/pool.js';
import { badRequest, notFound } from '../errors.js';
import { getSource } from '../ingest/sources.js';
import { BACKLOG_TYPES, terminologyBacklog } from '../terminology/backlog.js';
import { CONCEPTS, getConcept } from '../terminology/concepts.js';
import { loadedSystems, lookupCode } from '../terminology/service.js';
import { CODE_SYSTEMS } from '../terminology/systems.js';
import { clampInt } from './fhir.js';

const router = Router();

router.get('/concepts', (req, res) => {
  const domain = req.query.domain ?? null;
  res.json({
    concepts: CONCEPTS.filter((c) => !domain || c.domain === domain).map((c) => ({
      id: c.id,
      display: c.display,
      domain: c.domain,
      ...(c.unit && { unit: c.unit }),
      members: c.members.length,
    })),
  });
});

router.get('/concepts/:id', (req, res) => {
  const c = getConcept(req.params.id);
  if (!c) throw notFound(`Unknown concept '${req.params.id}'`);
  res.json({
    id: c.id,
    display: c.display,
    domain: c.domain,
    description: c.description ?? null,
    ...(c.unit && { unit: c.unit, acceptedUnits: Object.entries(c.units).map(([unit, rule]) => ({ unit, conversion: rule.label ?? 'none' })) }),
    members: c.members.map(({ system, code, display, match, note, status }) => ({ system, code, display, match, note, status })),
    excluded: (c.excluded ?? []).map(({ system, code, display, reason }) => ({ system, code, display, reason })),
  });
});

// "Given a LOINC code, return the canonical internal concept." Same for ICD-10-CM;
// SNOMED CT answers that its content is not loaded.
router.get('/terminology/lookup', async (req, res) => {
  const { system, code } = req.query;
  if (!system || !code) throw badRequest('system and code are required, e.g. ?system=loinc&code=4548-4');
  const param = String(system).toLowerCase();
  const shorthand = Object.entries(CODE_SYSTEMS).find(([, s]) => s.param === param)?.[0];
  res.json(await lookupCode(pool, shorthand ?? String(system), String(code)));
});

// The concept catalog's to-do list, read off the stored data: codes that reach no
// concept, ranked by how many resources each one would unlock.
router.get('/terminology/backlog', async (req, res) => {
  const resourceType = String(req.query.resourceType ?? 'Observation');
  if (!BACKLOG_TYPES[resourceType]) throw badRequest(`resourceType must be one of: ${Object.keys(BACKLOG_TYPES).join(', ')}`);
  const source = req.query.source ? (await getSource(pool, String(req.query.source))).id : null;
  res.json(
    await terminologyBacklog(pool, {
      resourceType,
      source,
      kind: req.query.kind ? String(req.query.kind) : null,
      limit: clampInt(req.query.limit, 50, 1, 500),
    }),
  );
});

router.get('/terminology/systems', async (req, res) => {
  const loaded = await loadedSystems(pool);
  res.json({
    systems: Object.entries(CODE_SYSTEMS).map(([url, s]) => {
      const release = loaded.get(url);
      return {
        url,
        name: s.name,
        param: s.param,
        ...(s.unsupported && { note: s.unsupported }),
        loaded: release ? { content: release.content, version: release.version, codes: release.code_count, source: release.source, at: release.loaded_at } : null,
      };
    }),
  });
});

export default router;

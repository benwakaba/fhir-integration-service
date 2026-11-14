import { Router } from 'express';
import pool from '../db/pool.js';
import { listSources } from '../ingest/sources.js';
import { validateResource } from '../validation/index.js';
import { conformanceReport } from '../validation/report.js';
import { FHIR_JSON, operationOutcome } from '../fhir/present.js';

const router = Router();

// Ad-hoc validation of any resource. ?format=outcome answers with an OperationOutcome.
router.post('/validate', async (req, res) => {
  const issues = await validateResource(pool, req.body);
  const errors = issues.filter((i) => i.severity === 'error').length;
  if (req.query.format === 'outcome') {
    const outcome = operationOutcome('information', 'informational', issues.length ? null : 'No issues found', issues);
    return res.type(FHIR_JSON).json(outcome);
  }
  const byCategory = {};
  for (const i of issues) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  res.json({ valid: errors === 0, errors, warnings: issues.length - errors, byCategory, issues });
});

router.get('/conformance', async (req, res) => {
  const sources = await listSources(pool);
  const summaries = [];
  for (const source of sources) {
    const report = await conformanceReport(pool, source.id);
    if (!Object.keys(report.resources).length) continue;
    summaries.push({
      source: report.source,
      resources: report.resources,
      resourcesWithErrors: report.validation.resourcesWithErrors,
      topFindings: report.findings.slice(0, 5),
    });
  }
  res.json({ sources: summaries });
});

router.get('/conformance/:source', async (req, res) => {
  res.json(await conformanceReport(pool, req.params.source));
});

export default router;

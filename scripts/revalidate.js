// Re-validate the current version of every stored resource (optionally one
// source), replacing its recorded issues. Needed after loading terminology
// releases or regenerating validation rules, since issues are recorded at write time.
//
//   npm run revalidate [-- --source smart]

import { parseArgs } from 'node:util';
import pool, { withTransaction } from '../src/db/pool.js';
import { recordIssues } from '../src/ingest/pipeline.js';
import { validateResources } from '../src/validation/index.js';

const { values } = parseArgs({ options: { source: { type: 'string' } } });

try {
  let lastId = 0;
  let total = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, version_id, resource FROM resources
       WHERE id > $1 AND NOT deleted AND ($2::text IS NULL OR source_id = $2)
       ORDER BY id LIMIT 500`,
      [lastId, values.source ?? null],
    );
    if (!rows.length) break;
    await withTransaction(async (client) => {
      const issues = await validateResources(client, rows.map((r) => r.resource));
      for (let i = 0; i < rows.length; i++) await recordIssues(client, rows[i], issues[i]);
    });
    total += rows.length;
    lastId = rows.at(-1).id;
  }
  console.log(`Re-validated ${total} resources.`);
} catch (err) {
  console.error(`Revalidation failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

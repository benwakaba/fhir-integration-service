import { notFound } from '../errors.js';

export async function getSource(db, id) {
  const { rows } = await db.query('SELECT * FROM sources WHERE id = $1', [id]);
  if (!rows[0]) throw notFound(`Unknown source '${id}'`);
  return rows[0];
}

export async function listSources(db) {
  const { rows } = await db.query('SELECT * FROM sources ORDER BY priority, id');
  return rows;
}

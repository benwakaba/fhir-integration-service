import { Pool, types } from 'pg';
import { config } from '../config.js';

// bigint (int8) arrives as a string by default; ids here stay far below 2^53.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

const pool = new Pool({
  connectionString: config.databaseUrl,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;

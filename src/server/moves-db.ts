/** Line-movement history in Postgres, so it survives page refreshes, restarts and deploys.
 *  Only on when DATABASE_URL is set; without it the app keeps moves in memory as before. */
import pg from 'pg';
import type { ChangeSet } from '../core/store.js';
import type { Quote } from '../core/types.js';

export type Move = { at: number; q: Quote; prev: NonNullable<ChangeSet['changes'][number]['prev']> };

const url = process.env.DATABASE_URL;
const pool = url
  ? new pg.Pool({ connectionString: url, ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined })
  : null;

/** Create the table if needed and load the newest moves. */
export async function loadMoves(limit: number): Promise<Move[]> {
  if (!pool) return [];
  await pool.query(`CREATE TABLE IF NOT EXISTS line_moves (
    id    BIGSERIAL PRIMARY KEY,
    at    BIGINT NOT NULL,
    quote JSONB  NOT NULL,
    prev  JSONB  NOT NULL
  )`);
  const { rows } = await pool.query('SELECT at, quote, prev FROM line_moves ORDER BY id DESC LIMIT $1', [limit]);
  return rows.map((r) => ({ at: Number(r.at), q: r.quote, prev: r.prev }));
}

/** Save one move. Fire and forget: a slow database never delays the live board. */
export function saveMove(m: Move): void {
  if (!pool) return;
  pool
    .query('INSERT INTO line_moves (at, quote, prev) VALUES ($1, $2, $3)', [m.at, JSON.stringify(m.q), JSON.stringify(m.prev)])
    .catch((e) => console.error('saveMove failed', String(e)));
}

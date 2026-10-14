import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const configuredPath = process.env.DATABASE_PATH ?? './data/app.db';
// ':memory:' is SQLite's own special value for a genuine in-memory database —
// path.resolve() would otherwise treat it as a relative filename and silently
// create a real file called ":memory:" on disk, defeating the entire point.
const dbPath = configuredPath === ':memory:' ? configuredPath : path.resolve(configuredPath);
// SQLite creates the file but not its directory — data/ is gitignored, so it
// won't exist on a fresh clone.
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);

// WAL mode: readers don't block the writer (and vice versa) — matters once more
// than one request can be in flight at a time. Off by default in SQLite.
sqlite.pragma('journal_mode = WAL');

// Off by default in SQLite for historical reasons — without this, every `references()`
// in schema.ts (cascades, set-nulls) is decorative only and silently not enforced.
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs fn as one SQLite transaction: all of its writes are saved, or — if it
 * throws — none are. Use it whenever a request writes more than one thing.
 *
 * fn must be synchronous. better-sqlite3 transactions are, so an async callback
 * throws — and anything after its first `await` would run outside the
 * transaction anyway. Inside fn, finish queries with .run() / .get() / .all()
 * (or .sync() for tx.query lookups) instead of awaiting them; do anything
 * genuinely async (password hashing, sending email) before or after.
 *
 * 'immediate' takes the write lock up front, so a transaction that reads before
 * it writes can't fail partway through waiting to upgrade its lock.
 */
export function transaction<T>(fn: (tx: Transaction) => T): T {
  return db.transaction(fn, { behavior: 'immediate' });
}

// Exposed for the rare case something needs the raw driver (e.g. the session store,
// which wants a better-sqlite3 instance directly rather than a Drizzle wrapper).
export const rawSqlite = sqlite;

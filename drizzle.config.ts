import './src/lib/load-env.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineConfig } from 'drizzle-kit';

const databasePath = process.env.DATABASE_PATH ?? './data/app.db';

// `drizzle-kit migrate` is usually the first thing run on a fresh clone, before
// data/ (gitignored) exists — and SQLite won't create the directory itself.
mkdirSync(dirname(databasePath), { recursive: true });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: databasePath,
  },
});

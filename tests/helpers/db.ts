import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../../src/db/client.js';

export async function applyMigrations(): Promise<void> {
  // fileURLToPath, not URL.pathname — on Windows .pathname gives "/C:/...",
  // which isn't a valid filesystem path.
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../src/db/migrations', import.meta.url)) });
}

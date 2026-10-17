import { z } from 'zod';
import { eq, sql, count } from 'drizzle-orm';
import { db, transaction, type Transaction } from '../db/client.js';
import { industries, companyIndustries } from '../db/schema.js';

// Industries are added by members (from the company form), the CSV import and
// the seed, and tidied up by admins on the Admin page. Names are unique ignoring
// capitals, so "Fintech" and "FinTech" can't both exist.

export const INDUSTRY_NAME_MAX_LENGTH = 60;

export const industryNameField = z.string().trim()
  .min(1, 'Enter a name')
  .max(INDUSTRY_NAME_MAX_LENGTH, `Industry names can be at most ${INDUSTRY_NAME_MAX_LENGTH} characters`);

/** How industries are listed everywhere: A–Z, ignoring capitals. */
export const industryNameOrder = sql`${industries.name} COLLATE NOCASE`;

/** The industry with this name, ignoring capitals, if there is one. */
export function findIndustryByName(name: string, tx: typeof db | Transaction = db) {
  return tx.select().from(industries).where(sql`lower(${industries.name}) = lower(${name})`).get();
}

/** Every industry, A–Z, with how many companies list it. */
export function industriesWithCounts() {
  return db.select({ id: industries.id, name: industries.name, companyCount: count(companyIndustries.companyId) })
    .from(industries)
    .leftJoin(companyIndustries, eq(companyIndustries.industryId, industries.id))
    .groupBy(industries.id)
    .orderBy(industryNameOrder)
    .all();
}

// The admin actions below each return why they couldn't be done, or null once done.

export function renameIndustry(id: number, name: string): string | null {
  const existing = findIndustryByName(name);
  if (existing && existing.id !== id) return `"${existing.name}" already exists — merge into it instead.`;
  db.update(industries).set({ name }).where(eq(industries.id, id)).run();
  return null;
}

/** Moves every company in one industry to another (once, if it's in both), then removes the first. */
export function mergeIndustry(id: number, intoId: number): string | null {
  if (id === intoId) return 'Choose a different industry to merge into.';
  return transaction((tx) => {
    const from = tx.select().from(industries).where(eq(industries.id, id)).get();
    const into = tx.select().from(industries).where(eq(industries.id, intoId)).get();
    if (!from || !into) return 'That industry no longer exists.';
    tx.run(sql`INSERT OR IGNORE INTO ${companyIndustries} (company_id, industry_id)
      SELECT company_id, ${intoId} FROM ${companyIndustries} WHERE industry_id = ${id}`);
    tx.delete(companyIndustries).where(eq(companyIndustries.industryId, id)).run();
    tx.delete(industries).where(eq(industries.id, id)).run();
    return null;
  });
}

/** Only an industry no company lists can be deleted — merge one that's in use instead. */
export function deleteIndustry(id: number): string | null {
  const [{ used }] = db.select({ used: count() }).from(companyIndustries).where(eq(companyIndustries.industryId, id)).all();
  if (used > 0) return `That industry is used by ${used} ${used === 1 ? 'company' : 'companies'} — merge it into another instead.`;
  db.delete(industries).where(eq(industries.id, id)).run();
  return null;
}

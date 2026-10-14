import crypto from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { db, type Transaction } from '../db/client.js';
import { authTokens } from '../db/schema.js';

export type TokenPurpose = 'invite_setup' | 'password_reset' | 'email_verify';

/** How long each kind of link works — the emails that send them say so (see lifetimeText). */
const EXPIRY_MS: Record<TokenPurpose, number> = {
  invite_setup: 48 * 60 * 60 * 1000,
  password_reset: 15 * 60 * 1000,
  email_verify: 24 * 60 * 60 * 1000,
};

/** A link's lifetime in words — "48 hours", "15 minutes" — for its email. */
export function lifetimeText(purpose: TokenPurpose): string {
  const minutes = EXPIRY_MS[purpose] / 60_000;
  const [count, unit] = minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Creates a token record and returns the RAW value — the only time it's ever
 * available in plaintext. Only its hash is stored, same reasoning as passwords.
 * Any earlier unused token for the same user and purpose stops working, so only
 * the most recent link of each kind does (e.g. an old email-verification link
 * can't confirm an address requested later). Pass a transaction (see
 * db/client.ts) to create it as part of a larger write. */
export function createToken(userId: number, purpose: TokenPurpose, tx: typeof db | Transaction = db): string {
  const raw = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  tx.update(authTokens).set({ usedAt: now })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)))
    .run();
  tx.insert(authTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(raw),
    expiresAt: new Date(now.getTime() + EXPIRY_MS[purpose]),
    createdAt: now,
  }).run();
  return raw;
}

type TokenLookupResult =
  | { valid: false }
  | { valid: true; userId: number; tokenId: number; purpose: TokenPurpose };

/** Looks up a raw token for one specific purpose. Does not mark it used —
 * consumeToken() does that, in the same transaction as the action it authorizes. */
export async function lookupToken(raw: string, purpose: TokenPurpose): Promise<TokenLookupResult> {
  const hash = hashToken(raw);
  const row = await db.query.authTokens.findFirst({
    where: and(eq(authTokens.tokenHash, hash), eq(authTokens.purpose, purpose)),
  });

  if (!row) return { valid: false };
  if (row.usedAt) return { valid: false };
  if (row.expiresAt.getTime() < Date.now()) return { valid: false };

  return { valid: true, userId: row.userId, tokenId: row.id, purpose };
}

/**
 * Accepting an invite reuses the reset-password page (both set a password), so
 * the landing route needs to check both purposes without knowing in advance
 * which one a given link is. Tries invite_setup first, falls back to
 * password_reset — a token hash is only ever inserted under one purpose, so at
 * most one of these two lookups can succeed.
 */
export async function lookupResetOrInviteToken(raw: string): Promise<TokenLookupResult> {
  const invite = await lookupToken(raw, 'invite_setup');
  if (invite.valid) return invite;
  return lookupToken(raw, 'password_reset');
}

/** Marks a token used, inside the same transaction as the change it authorizes
 * — so the token is only spent if that change is saved too. Returns false if it
 * had already been used (e.g. the same link submitted twice at once), in which
 * case the caller should abort without making the change. */
export function consumeToken(tokenId: number, tx: Transaction): boolean {
  const { changes } = tx.update(authTokens).set({ usedAt: new Date() })
    .where(and(eq(authTokens.id, tokenId), isNull(authTokens.usedAt)))
    .run();
  return changes === 1;
}

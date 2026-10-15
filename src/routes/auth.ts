import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, transaction } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { newPasswordField, displayNameField, emailField } from '../lib/account-fields.js';
import { createToken, lookupResetOrInviteToken, consumeToken } from '../lib/tokens.js';
import { sendPasswordResetEmail } from '../lib/email.js';
import { endSessions } from '../lib/sessions.js';
import { loginLimiter, forgotPasswordLimiter } from '../middleware/rate-limit.js';

export const authRouter = Router();

// ---------- Login / logout ----------

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1),
}).strict();

authRouter.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('auth/login');
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('auth/login', { error: 'Enter a valid email and password.' });
  }

  const user = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });

  // Identical response whether the email doesn't exist, the account is still a
  // pending invite (no password set), or the password is wrong — never reveal
  // which case it was. verifyPassword takes as long in every case, so the
  // response time doesn't give it away either.
  const valid = await verifyPassword(parsed.data.password, user?.passwordHash);
  if (!valid || !user) {
    return res.status(401).render('auth/login', { error: 'Incorrect email or password.' });
  }

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    res.redirect('/');
  });
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Forgot password ----------

const forgotPasswordSchema = z.object({ email: emailField }).strict();

authRouter.get('/forgot-password', (_req, res) => {
  res.render('auth/forgot-password');
});

authRouter.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (parsed.success) {
    const user = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
    if (user) {
      const token = createToken(user.id, 'password_reset');
      // Not awaited: waiting on the email service would make this response
      // noticeably slower for members than for anyone else.
      sendPasswordResetEmail(user.email, token).catch((err) => console.error(err));
    }
  }
  // Same response either way: an unauthenticated "did this work" response must
  // not reveal who's a member.
  res.render('auth/forgot-password', { submitted: true });
});

// ---------- Reset password (also serves invite acceptance) ----------

const setPasswordSchema = z.object({
  password: newPasswordField,
  displayName: displayNameField.optional(),
}).strict();

/** Whether the page also asks for a display name: when accepting an invite, or
 * resetting the password of an account that never accepted its invite — so no
 * one gets in without one. */
async function lacksDisplayName(userId: number): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return !user?.displayName;
}

authRouter.get('/reset-password/:token', async (req, res) => {
  const result = await lookupResetOrInviteToken(req.params.token);
  if (!result.valid) return res.status(400).render('auth/reset-password', { valid: false });

  res.render('auth/reset-password', { valid: true, needsDisplayName: await lacksDisplayName(result.userId) });
});

authRouter.post('/reset-password/:token', async (req, res, next) => {
  const result = await lookupResetOrInviteToken(req.params.token);
  if (!result.valid) return res.status(400).render('auth/reset-password', { valid: false });
  const { userId, tokenId } = result;

  const needsDisplayName = await lacksDisplayName(userId);
  const fail = (error: string) => res.status(400).render('auth/reset-password', { valid: true, needsDisplayName, error });

  const parsed = setPasswordSchema.safeParse(req.body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid submission.');
  if (needsDisplayName && !parsed.data.displayName) return fail('Display name is required');
  const { displayName } = parsed.data;

  const passwordHash = await hashPassword(parsed.data.password);
  const saved = transaction((tx) => {
    if (!consumeToken(tokenId, tx)) return false;
    tx.update(users)
      .set({ passwordHash, ...(needsDisplayName ? { displayName } : {}) })
      .where(eq(users.id, userId))
      .run();
    // A reset usually means the old password can't be trusted: sign out every
    // existing session (this browser gets a fresh one below).
    endSessions(userId);
    return true;
  });
  if (!saved) return res.status(400).render('auth/reset-password', { valid: false });

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    res.redirect('/');
  });
});

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq, sql, desc } from 'drizzle-orm';
import { db, transaction } from '../db/client.js';
import { users, reviews, companies } from '../db/schema.js';
import { requireAuth, requireSelfOrAdmin, type CurrentUser } from '../middleware/auth.js';
import { accountChangeLimiter } from '../middleware/rate-limit.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { newPasswordField, displayNameField, emailField } from '../lib/account-fields.js';
import { createToken, lookupToken, consumeToken } from '../lib/tokens.js';
import { sendEmailVerification } from '../lib/email.js';
import { endSessions } from '../lib/sessions.js';

export const accountRouter = Router();

export async function isLastAdmin(userId: number): Promise<boolean> {
  const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!target || target.role !== 'admin') return false;
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin'));
  return count <= 1;
}

/** The account page for viewedUser, as seen by the signed-in user — with an
 * optional per-section message (e.g. { nameError }) and status code. */
function renderAccount(
  req: Request,
  res: Response,
  viewedUser: CurrentUser,
  messages?: Record<string, string | undefined>,
  status = 200,
) {
  res.status(status).render('account/show', {
    viewedUser,
    isSelf: req.currentUser!.id === viewedUser.id,
    isAdmin: req.currentUser!.role === 'admin',
    messages,
  });
}

/** Changing your own email or password needs your current password too — so a
 * session left signed in (or stolen) can't be used to take the account over.
 * An admin changing someone else's doesn't (and shouldn't) need to know theirs. */
async function confirmsCurrentPassword(req: Request, user: CurrentUser, currentPassword: string | undefined) {
  if (req.currentUser!.id !== user.id) return true;
  return verifyPassword(currentPassword ?? '', user.passwordHash);
}

accountRouter.get('/account', requireAuth, (req, res) => {
  res.redirect(`/users/${req.currentUser!.id}`);
});

accountRouter.get('/account/reviews', requireAuth, async (req, res) => {
  const rows = await db.select({ company: companies, review: reviews })
    .from(reviews)
    .innerJoin(companies, eq(reviews.companyId, companies.id))
    .where(eq(reviews.userId, req.currentUser!.id))
    .orderBy(desc(reviews.createdAt));

  res.render('account/reviews', { rows });
});

accountRouter.get('/users/:id', requireSelfOrAdmin, (req, res) => {
  renderAccount(req, res, req.targetUser!);
});

const updateNameSchema = z.object({ displayName: displayNameField }).strict();

accountRouter.post('/users/:id', requireSelfOrAdmin, async (req, res) => {
  const user = req.targetUser!;
  const parsed = updateNameSchema.safeParse(req.body);
  if (!parsed.success) return renderAccount(req, res, user, { nameError: parsed.error.issues[0]?.message }, 400);

  await db.update(users).set({ displayName: parsed.data.displayName }).where(eq(users.id, user.id));
  res.redirect(`/users/${user.id}`);
});

const updateEmailSchema = z.object({
  email: emailField,
  currentPassword: z.string().optional(),
}).strict();

accountRouter.post('/users/:id/email', requireSelfOrAdmin, accountChangeLimiter, async (req, res) => {
  const user = req.targetUser!;
  const parsed = updateEmailSchema.safeParse(req.body);
  if (!parsed.success) return renderAccount(req, res, user, { emailError: parsed.error.issues[0]?.message }, 400);
  if (!await confirmsCurrentPassword(req, user, parsed.data.currentPassword)) {
    return renderAccount(req, res, user, { emailError: 'Current password is incorrect.' }, 400);
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (existing && existing.id !== user.id) {
    return renderAccount(req, res, user, { emailError: 'That email is already in use.' }, 400);
  }

  const token = transaction((tx) => {
    tx.update(users).set({ pendingEmail: parsed.data.email }).where(eq(users.id, user.id)).run();
    return createToken(user.id, 'email_verify', tx);
  });
  await sendEmailVerification(parsed.data.email, token);

  renderAccount(req, res, { ...user, pendingEmail: parsed.data.email }, {
    emailMessage: `Verification link sent to ${parsed.data.email}.`,
  });
});

accountRouter.get('/verify-email/:token', async (req, res) => {
  const result = await lookupToken(req.params.token, 'email_verify');
  if (!result.valid) return res.status(400).render('account/verify-email-result', { success: false });
  const { userId, tokenId } = result;

  const verified = transaction((tx) => {
    const user = tx.query.users.findFirst({ where: eq(users.id, userId) }).sync();
    if (!user?.pendingEmail || !consumeToken(tokenId, tx)) return false;
    tx.update(users).set({ email: user.pendingEmail, pendingEmail: null }).where(eq(users.id, userId)).run();
    return true;
  });

  res.status(verified ? 200 : 400).render('account/verify-email-result', { success: verified });
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: newPasswordField,
}).strict();

accountRouter.post('/users/:id/password', requireSelfOrAdmin, accountChangeLimiter, async (req, res) => {
  const user = req.targetUser!;
  const parsed = updatePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return renderAccount(req, res, user, { passwordError: parsed.error.issues[0]?.message ?? 'Invalid submission.' }, 400);
  }
  if (!await confirmsCurrentPassword(req, user, parsed.data.currentPassword)) {
    return renderAccount(req, res, user, { passwordError: 'Current password is incorrect.' }, 400);
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  transaction((tx) => {
    tx.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
    // Signs them out everywhere else — keeping this browser signed in if it's theirs.
    endSessions(user.id, req.sessionID);
  });

  renderAccount(req, res, user, { passwordMessage: 'Password updated.' });
});

// A checkbox: submits 'true' when ticked, nothing at all when not.
const notificationsSchema = z.object({ notifyOnFlags: z.literal('true').optional() }).strict();

accountRouter.post('/users/:id/notifications', requireSelfOrAdmin, async (req, res) => {
  const user = req.targetUser!;
  const parsed = notificationsSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect(`/users/${user.id}`);

  await db.update(users).set({ notifyOnFlags: parsed.data.notifyOnFlags === 'true' }).where(eq(users.id, user.id));
  res.redirect(`/users/${user.id}`);
});

const updateRoleSchema = z.object({ role: z.enum(['user', 'admin']) }).strict();

accountRouter.post('/users/:id/role', requireSelfOrAdmin, async (req, res) => {
  // requireSelfOrAdmin already ensures the actor is either this user or an
  // admin — but role changes are never self-service, so enforce admin-only
  // explicitly rather than relying on the shared guard's self-branch.
  if (req.currentUser!.role !== 'admin') return res.status(403).render('errors/403');

  const user = req.targetUser!;
  const parsed = updateRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect(`/users/${user.id}`);

  if (parsed.data.role === 'user' && await isLastAdmin(user.id)) {
    return renderAccount(req, res, user, { roleError: 'Cannot remove the last remaining admin.' }, 400);
  }

  await db.update(users).set({ role: parsed.data.role }).where(eq(users.id, user.id));
  res.redirect(`/users/${user.id}`);
});

accountRouter.post('/users/:id/delete', requireSelfOrAdmin, async (req, res) => {
  const target = req.targetUser!;
  if (await isLastAdmin(target.id)) {
    return renderAccount(req, res, target, { roleError: 'Cannot delete the last remaining admin.' }, 400);
  }

  transaction((tx) => {
    // Preserve the display name on their reviews before deletion nulls the
    // user_id link (via the FK's ON DELETE SET NULL) — otherwise a deleted
    // account's past reviews would show no name at all.
    tx.update(reviews)
      .set({ deletedUserDisplayName: target.displayName })
      .where(eq(reviews.userId, target.id))
      .run();
    tx.delete(users).where(eq(users.id, target.id)).run();
  });

  if (req.currentUser!.id === target.id) {
    req.session.destroy(() => res.redirect('/'));
  } else {
    res.redirect('/');
  }
});

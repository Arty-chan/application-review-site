import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, transaction } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { inviteLimiter } from '../middleware/rate-limit.js';
import { createToken } from '../lib/tokens.js';
import { sendInviteEmail } from '../lib/email.js';
import { emailField } from '../lib/account-fields.js';

export const inviteRouter = Router();

const inviteSchema = z.object({ email: emailField }).strict();

inviteRouter.get('/invites', requireAuth, (_req, res) => {
  res.render('auth/invite');
});

inviteRouter.post('/invites', requireAuth, inviteLimiter, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('auth/invite', { error: 'Enter a valid email.' });
  }

  // An account with a password has accepted its invite. One without is an
  // invite never accepted (perhaps expired): it's sent again, and the new link
  // replaces the old one.
  const existing = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (existing?.passwordHash) {
    return res.render('auth/invite', { message: `${parsed.data.email} is already a member.` });
  }

  // A new account and its invite token together or not at all.
  const token = transaction((tx) => {
    const userId = existing?.id ?? tx.insert(users).values({
      email: parsed.data.email,
      role: 'user',
      invitedBy: req.currentUser!.id,
      createdAt: new Date(),
    }).returning().get().id;
    return createToken(userId, 'invite_setup', tx);
  });
  // Sent only once the transaction has committed — an email can't be rolled back.
  await sendInviteEmail(parsed.data.email, token);

  res.render('auth/invite', { message: `Invite sent to ${parsed.data.email}.` });
});

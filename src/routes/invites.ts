import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, transaction } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { inviteLimiter } from '../middleware/rate-limit.js';
import { createToken } from '../lib/tokens.js';
import { sendInviteEmail } from '../lib/email.js';

export const inviteRouter = Router();

const inviteSchema = z.object({ email: z.string().email() }).strict();

inviteRouter.get('/invites', requireAuth, (_req, res) => {
  res.render('auth/invite');
});

inviteRouter.post('/invites', requireAuth, inviteLimiter, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).render('auth/invite', { error: 'Enter a valid email.' });
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (existing) {
    return res.render('auth/invite', { message: `${parsed.data.email} is already a member.` });
  }

  // The account and its invite token together or not at all — an account
  // without a token would be stuck, since it can't be invited again.
  const token = transaction((tx) => {
    const newUser = tx.insert(users).values({
      email: parsed.data.email,
      role: 'user',
      invitedBy: req.currentUser!.id,
      createdAt: new Date(),
    }).returning().get();
    return createToken(newUser.id, 'invite_setup', tx);
  });
  // Sent only once the transaction has committed — an email can't be rolled back.
  await sendInviteEmail(parsed.data.email, token);

  res.render('auth/invite', { message: `Invite sent to ${parsed.data.email}.` });
});

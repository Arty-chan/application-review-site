import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, reviewFlags, users } from '../db/schema.js';
import { requireAdmin } from '../middleware/auth.js';
import { hashPassword } from '../lib/passwords.js';
import { newPasswordField, displayNameField } from '../lib/account-fields.js';

export const adminRouter = Router();

adminRouter.post('/companies/:id/delete', requireAdmin, async (req, res) => {
  // Cascades reviews, flags (via reviews), and favorites — all set up as
  // ON DELETE CASCADE in the schema, so this is the one statement that needs to run.
  await db.delete(companies).where(eq(companies.id, Number(req.params.id)));
  res.redirect('/');
});

adminRouter.get('/admin/flags', requireAdmin, async (_req, res) => {
  const flags = await db.query.reviewFlags.findMany({
    orderBy: (f, { desc }) => [desc(f.createdAt)],
    with: {
      review: { with: { company: true, user: true } },
      flaggedByUser: true,
    },
  });
  res.render('admin/flags', { flags });
});

adminRouter.post('/flags/:id/resolve', requireAdmin, async (req, res) => {
  await db.update(reviewFlags).set({
    status: 'dismissed',
    resolvedBy: req.currentUser!.id,
    resolvedAt: new Date(),
  }).where(eq(reviewFlags.id, Number(req.params.id)));
  res.redirect('/admin/flags');
});

// An account set up directly by an admin, password and all — no invite email
// needed, so it works before email is set up (and for testing locally).
const newUserSchema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  displayName: displayNameField,
  password: newPasswordField,
  role: z.enum(['user', 'admin']),
}).strict();

adminRouter.get('/admin/users/new', requireAdmin, (_req, res) => {
  res.render('admin/new-user', { values: { role: 'user' } });
});

adminRouter.post('/admin/users/new', requireAdmin, async (req, res) => {
  // The form is shown again with what was typed — except the password.
  const fail = (error: string) => res.status(400).render('admin/new-user', { error, values: req.body });
  const parsed = newUserSchema.safeParse(req.body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid submission.');

  const existing = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (existing) return fail('A user with that email already exists.');

  const [user] = await db.insert(users).values({
    email: parsed.data.email,
    displayName: parsed.data.displayName,
    passwordHash: await hashPassword(parsed.data.password),
    role: parsed.data.role,
    invitedBy: req.currentUser!.id,
    createdAt: new Date(),
  }).returning();

  res.redirect(`/users/${user.id}`);
});

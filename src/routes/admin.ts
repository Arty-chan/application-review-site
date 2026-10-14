import { Router, type Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, reviewFlags, users } from '../db/schema.js';
import { requireAdmin } from '../middleware/auth.js';
import { hashPassword } from '../lib/passwords.js';
import { newPasswordField, displayNameField } from '../lib/account-fields.js';
import { visibilityGroups, currentVisibility, saveVisibility } from '../lib/visibility.js';
import { visibilityLevels } from '../config/company-attributes.js';
import { importColumns, importHeaderRow, importCompanies, type ImportOutcome } from './import.js';

export const adminRouter = Router();

adminRouter.post('/companies/:id/delete', requireAdmin, async (req, res) => {
  // Cascades reviews, flags (via reviews), and favorites — all set up as
  // ON DELETE CASCADE in the schema, so this is the one statement that needs to run.
  await db.delete(companies).where(eq(companies.id, Number(req.params.id)));
  res.redirect('/');
});

// ---------- The Admin page ----------
//
// One page with a section for each admin tool, stacked like the account page:
// flags, adding a user, who can see what, and the CSV import. Each section's
// form posts to its own route below, which shows the page again with that
// section's outcome (the form's action ends in the section's #id, so the
// browser scrolls back to it).

interface SectionOutcomes {
  addUser?: { error: string; values: Record<string, unknown> };
  settings?: { message?: string; error?: string };
  csvImport?: ImportOutcome;
}

async function renderAdminPage(res: Response, outcomes: SectionOutcomes = {}, status = 200) {
  const flags = await db.query.reviewFlags.findMany({
    orderBy: (f, { desc }) => [desc(f.createdAt)],
    with: {
      review: { with: { company: true, user: true } },
      flaggedByUser: true,
    },
  });
  const visibility = currentVisibility();

  res.status(status).render('admin/index', {
    openFlags: flags.filter((f) => f.status === 'open'),
    dismissedFlags: flags.filter((f) => f.status !== 'open'),
    settingGroups: visibilityGroups.map((group) => ({
      ...group,
      settings: group.settings.map((s) => ({ ...s, visibility: visibility.get(s.key) })),
    })),
    visibilityLevels,
    importColumns,
    importHeaderRow,
    addUser: { values: { role: 'user' } },
    ...outcomes,
  });
}

adminRouter.get('/admin', requireAdmin, async (_req, res) => {
  await renderAdminPage(res);
});

// Opening a section's own URL leads to that section: the tools used to be
// separate pages (linked from flag emails already sent, say), and a form's URL
// stays in the address bar after it's submitted.
const sectionUrls: Record<string, string> = {
  '/admin/flags': 'flags',
  '/admin/users/new': 'add-user',
  '/admin/settings': 'settings',
  '/admin/import': 'import',
};
adminRouter.get(Object.keys(sectionUrls), requireAdmin, (req, res) => {
  res.redirect(`/admin#${sectionUrls[req.path]}`);
});

adminRouter.post('/flags/:id/resolve', requireAdmin, async (req, res) => {
  await db.update(reviewFlags).set({
    status: 'dismissed',
    resolvedBy: req.currentUser!.id,
    resolvedAt: new Date(),
  }).where(eq(reviewFlags.id, Number(req.params.id)));
  res.redirect('/admin#flags');
});

// An account set up directly by an admin, password and all — no invite email
// needed, so it works before email is set up (and for testing locally).
const newUserSchema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  displayName: displayNameField,
  password: newPasswordField,
  role: z.enum(['user', 'admin']),
}).strict();

adminRouter.post('/admin/users/new', requireAdmin, async (req, res) => {
  // The form is shown again with what was typed — except the password.
  const fail = (error: string) => renderAdminPage(res, { addUser: { error, values: req.body } }, 400);
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

// One dropdown per setting, each one of the visibility levels.
const visibilityChoice = z.enum(visibilityLevels.map((l) => l.value));
const settingsSchema = z.object(Object.fromEntries(
  visibilityGroups.flatMap((g) => g.settings).map((s) => [s.key, visibilityChoice]),
)).strict();

adminRouter.post('/admin/settings', requireAdmin, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return renderAdminPage(res, { settings: { error: 'Choose who can see each setting.' } }, 400);
  saveVisibility(parsed.data);
  await renderAdminPage(res, { settings: { message: 'Settings saved.' } });
});

const importSchema = z.object({ csv: z.string().trim().min(1, 'Paste the CSV to import.') }).strict();

adminRouter.post('/admin/import', requireAdmin, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    return renderAdminPage(res, { csvImport: { csv: '', error: parsed.error.issues[0]?.message ?? 'Invalid submission.' } }, 400);
  }
  const outcome = await importCompanies(parsed.data.csv, req.currentUser!);
  await renderAdminPage(res, { csvImport: outcome }, 'error' in outcome ? 400 : 200);
});

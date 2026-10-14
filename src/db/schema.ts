import { sqliteTable, text, integer, primaryKey, unique } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

// ============================================================
// Users & Auth
// ============================================================

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  // Set while a change is pending; only copied into `email` once the verify link is clicked
  pendingEmail: text('pending_email'),
  // Null means "invited, hasn't set a password yet" — this IS the pending-invite state,
  // no separate status column needed.
  passwordHash: text('password_hash'),
  // Null until the invited user picks one at activation time (alongside their
  // password) — can't be required at insert time since the inviter doesn't choose it.
  displayName: text('display_name'),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  // Admins only: whether they get an email when a review is flagged.
  notifyOnFlags: integer('notify_on_flags', { mode: 'boolean' }).notNull().default(true),
  invitedBy: integer('invited_by').references((): any => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// Covers invite-setup, password-reset, and email-verify tokens — structurally identical,
// just different purposes and expiry windows (enforced in application code):
//   invite_setup   -> 48h
//   password_reset -> 15min
//   email_verify   -> 24h
export const authTokens = sqliteTable('auth_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose', { enum: ['invite_setup', 'password_reset', 'email_verify'] }).notNull(),
  // Store a hash of the token, never the raw value — same reasoning as password hashing.
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================
// Regions & Countries
// ============================================================
// Self-referencing tree so a branch can be as deep as needed
// (AMER -> LATAM -> Central America -> countries) without a schema change.
// Seeded from a data file + sync script, not editable through the app — see scripts/.

export const regions = sqliteTable('regions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // Null = top-level (AMER / EMEA / APAC)
  parentId: integer('parent_id').references((): any => regions.id),
}, (t) => [
  // Lets the seed script upsert by (name, parent) instead of duplicating nodes
  // on rerun. SQLite treats multiple NULLs as distinct, so this doesn't collide
  // for top-level regions sharing a null parent (name alone still disambiguates
  // AMER/EMEA/APAC since they're each inserted once).
  unique().on(t.name, t.parentId),
]);

export const countries = sqliteTable('countries', {
  code: text('code').primaryKey(), // ISO 3166-1 alpha-2
  name: text('name').notNull(),
  // The most specific region node this country belongs to (a leaf, usually)
  regionId: integer('region_id').notNull().references(() => regions.id),
});

// ============================================================
// Industries
// ============================================================
// Fixed list, but any signed-in user can add a new one inline from the company form.

export const industries = sqliteTable('industries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
});

// ============================================================
// Companies
// ============================================================

export const employeeSizeRanges = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'] as const;

export const companies = sqliteTable('companies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  websiteUrl: text('website_url').notNull(),
  // Normalized (protocol/www stripped) — this is what duplicate-checking actually
  // queries against, and what the unique index enforces. Careers URL is deliberately
  // NOT part of duplicate detection — many companies share an ATS-hosted careers page.
  websiteDomain: text('website_domain').notNull().unique(),
  careersUrl: text('careers_url'),
  employeeSizeRange: text('employee_size_range', { enum: employeeSizeRanges }),

  // Free-text, view/edit for signed-in users and up — not public. Unlike the tri-state
  // attributes below, this isn't a filterable tag, so it deliberately isn't part of the
  // company-attributes.ts registry; it's gated the same simple way updatedBy is (checked
  // directly in the view/route, not via the registry loop).
  generalNotes: text('general_notes'),

  // Tri-state: true / false / null ("unknown"). SQLite's boolean mode stores 0/1/NULL
  // natively, so "unknown" falls out for free rather than needing a sentinel value.
  // See src/config/company-attributes.ts — that registry, not this list, is what the
  // app reads from when deciding what to render or filter on.
  hiresRemote: integer('hires_remote', { mode: 'boolean' }),
  listsSalary: integer('lists_salary', { mode: 'boolean' }),
  requiresTakeHome: integer('requires_take_home', { mode: 'boolean' }),
  requires5PlusCalls: integer('requires_5plus_calls', { mode: 'boolean' }),
  requiresWorkTrial: integer('requires_work_trial', { mode: 'boolean' }),
  activelyHiring: integer('actively_hiring', { mode: 'boolean' }), // criteria: 5+ roles open
  publicHiringProcess: integer('public_hiring_process', { mode: 'boolean' }),
  postsGhostJobs: integer('posts_ghost_jobs', { mode: 'boolean' }),

  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const companyCountries = sqliteTable('company_countries', {
  companyId: integer('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  countryCode: text('country_code').notNull().references(() => countries.code),
}, (t) => [primaryKey({ columns: [t.companyId, t.countryCode] })]);

export const companyIndustries = sqliteTable('company_industries', {
  companyId: integer('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  industryId: integer('industry_id').notNull().references(() => industries.id),
}, (t) => [primaryKey({ columns: [t.companyId, t.industryId] })]);

// ============================================================
// Reviews & Flags
// ============================================================

export const reviews = sqliteTable('reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  companyId: integer('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  // Nulled (not cascade-deleted) when the reviewer's account is removed — the review stays.
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  // Populated only at the moment userId is nulled, so the review still shows a name
  // instead of "unknown" once the account is gone.
  deletedUserDisplayName: text('deleted_user_display_name'),

  rating: integer('rating'), // 1-10, half-star units (7 = 3.5 stars) — avoids float rounding; null = not rated
  comment: text('comment').notNull(),
  jobProcessDate: integer('job_process_date', { mode: 'timestamp' }).notNull(), // defaults to today, user-editable
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), // fixed, not user-editable
  editedAt: integer('edited_at', { mode: 'timestamp' }), // null until first edit

  // Reports the reviewer ticked on their review — see reviewReports in
  // src/config/company-attributes.ts. A plain yes/no: unticked means not reported.
  noReplyAfterApplication: integer('no_reply_after_application', { mode: 'boolean' }).notNull().default(false),
  noReplyAfterCall: integer('no_reply_after_call', { mode: 'boolean' }).notNull().default(false),
}, (t) => [
  // One review per user per company. SQLite treats multiple NULLs as distinct, so
  // reviews orphaned by account deletion (userId = null) never collide with this.
  unique().on(t.companyId, t.userId),
]);

export const reviewFlags = sqliteTable('review_flags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reviewId: integer('review_id').notNull().references(() => reviews.id, { onDelete: 'cascade' }),
  flaggedByUserId: integer('flagged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  comment: text('comment').notNull(),
  status: text('status', { enum: ['open', 'dismissed'] }).notNull().default('open'),
  resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================
// Favorites
// ============================================================
// Private to each user — no public/admin visibility into another user's list.

export const favorites = sqliteTable('favorites', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  companyId: integer('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.companyId] })]);

// ============================================================
// Relations — only what the relational queries' `with: {...}` actually loads
// (company detail: reviews + author; admin flags: flag + review + company +
// author + flagger). Add more here when a query needs them; they don't affect
// the database schema or migrations.
// ============================================================

export const reviewsRelations = relations(reviews, ({ one }) => ({
  company: one(companies, { fields: [reviews.companyId], references: [companies.id] }),
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
}));

export const reviewFlagsRelations = relations(reviewFlags, ({ one }) => ({
  review: one(reviews, { fields: [reviewFlags.reviewId], references: [reviews.id] }),
  flaggedByUser: one(users, { fields: [reviewFlags.flaggedByUserId], references: [users.id] }),
}));

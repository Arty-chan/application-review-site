/**
 * Single source of truth for what's known about a company's hiring process, and
 * who gets to see it:
 *
 * - companyAttributes: tri-state facts about the company itself (Yes / No /
 *   Unknown), set on the add/edit company form.
 * - reviewReports: things reviewers report by ticking a box on their review,
 *   shown on each company as the number of reviewers who reported it.
 * - reviewsSetting: who can read the reviews themselves.
 * - companyNotesSetting: who can read each company's free-text notes.
 * - importPageSetting: who can use the Import page.
 *
 * The company page, the search results, the search filters, and the forms all
 * loop over these lists rather than naming fields individually.
 *
 * Who can see each one is set by admins on the Admin page (stored in the
 * database — see src/lib/visibility.ts). The `defaultVisibility` here applies
 * only until an admin first saves those settings.
 *
 * IMPORTANT: visibility has to be enforced server-side too, not just in what the
 * UI renders. The search route checks it before honoring a filter param, so a
 * hidden item can't be filtered on by typing the param into the URL; and the
 * company form only shows and saves the attributes its editor can see.
 */

/** Who can see something, as offered on the Admin page. */
export const visibilityLevels = [
  { value: 'public', label: 'Everyone' },
  { value: 'user', label: 'Signed-in members' },
  { value: 'admin', label: 'Admins only' },
] as const;

export type Visibility = typeof visibilityLevels[number]['value'];

/** The signed-in user, or null/undefined for an anonymous visitor. */
export type Viewer = { role: 'user' | 'admin' } | null | undefined;

export function isAdmin(viewer: Viewer): boolean {
  return viewer?.role === 'admin';
}

export function canView(visibility: Visibility, viewer: Viewer): boolean {
  if (visibility === 'public') return true;
  if (visibility === 'user') return !!viewer;
  return isAdmin(viewer);
}

/** Anything whose visibility admins can set. Every key is unique across all of them. */
export interface VisibilitySettingDef {
  key: string;
  label: string;
  /** Optional helper text shown next to the label — e.g. clarifying criteria */
  helpText?: string;
  defaultVisibility: Visibility;
  /** The choices the Admin page offers for it, when not all of them. */
  levels?: Visibility[];
}

// ---------- Company attributes ----------

export interface CompanyAttributeDef extends VisibilitySettingDef {
  /** Matches the corresponding column name on companies in src/db/schema.ts.
   * Its visibility also decides who can see and change it on the company form. */
  key:
    | 'hiresRemote'
    | 'listsSalary'
    | 'requiresTakeHome'
    | 'requires5PlusCalls'
    | 'requiresWorkTrial'
    | 'activelyHiring'
    | 'publicHiringProcess'
    | 'postsGhostJobs';
  /** How the search can filter on it: 'require' shows only companies where it's
   * Yes; 'exclude' hides companies where it's Yes. */
  filter: 'require' | 'exclude' | null;
}

export const companyAttributes: CompanyAttributeDef[] = [
  { key: 'hiresRemote', label: 'Hires remote', defaultVisibility: 'public', filter: 'require' },
  { key: 'listsSalary', label: 'Lists salary', defaultVisibility: 'public', filter: 'require' },
  { key: 'requiresTakeHome', label: 'Requires take-home', defaultVisibility: 'public', filter: 'exclude' },
  { key: 'requires5PlusCalls', label: 'Requires 5+ calls', defaultVisibility: 'public', filter: 'exclude' },
  { key: 'requiresWorkTrial', label: 'Requires work trial', defaultVisibility: 'public', filter: 'exclude' },
  {
    key: 'activelyHiring',
    label: 'Actively hiring',
    helpText: 'Criteria: 5+ roles currently open',
    defaultVisibility: 'public',
    filter: 'require',
  },
  {
    key: 'publicHiringProcess',
    label: 'Publishes hiring process',
    helpText: 'Whether the stages are listed on the job description or website — not what they are',
    defaultVisibility: 'public',
    filter: 'require',
  },
  {
    key: 'postsGhostJobs',
    label: 'Posts ghost jobs',
    helpText: 'Job listings for roles that aren\'t actually being filled',
    defaultVisibility: 'public',
    filter: 'exclude',
  },
];

// ---------- Review reports ----------

export interface ReviewReportDef extends VisibilitySettingDef {
  /** Matches the corresponding boolean column on reviews in src/db/schema.ts.
   * Its visibility covers how many reviewers reported it for a company, and the
   * report on individual reviews (which also need the reviews' own visibility).
   * Any reviewer can still report it — this only limits who sees it. */
  key: 'noReplyAfterApplication' | 'noReplyAfterCall';
}

export const reviewReports: ReviewReportDef[] = [
  { key: 'noReplyAfterApplication', label: 'No reply after application', defaultVisibility: 'public' },
  { key: 'noReplyAfterCall', label: 'No reply after a call', defaultVisibility: 'public' },
];

// ---------- Company notes ----------

/** Who can read each company's free-text notes — and, since they're on the
 * company form, who can see and change them there. */
export const companyNotesSetting: VisibilitySettingDef = {
  key: 'generalNotes', // the notes' column on companies in src/db/schema.ts
  label: 'Notes',
  helpText: "The notes on each company's page, and the notes field on the company form.",
  defaultVisibility: 'user',
};

// ---------- Pages ----------

/** Who can use the Import page, to bulk-add companies from CSV — never anyone
 * signed out. Exporting companies there is for admins only, whatever this is. */
export const importPageSetting: VisibilitySettingDef = {
  key: 'importPage',
  label: 'Import page',
  helpText: 'Bulk-adding companies from CSV. Exporting them there is always admins only.',
  defaultVisibility: 'admin',
  levels: ['user', 'admin'],
};

// ---------- Reviews ----------

/** Who can read reviews: their text and star ratings, each company's average
 * rating, and sorting the search by rating. Anyone signed in can still write one
 * — this only limits who reads them. Reviewers' display names are a separate,
 * fixed rule: signed-in users only (see MASKED_NAME). */
export const reviewsSetting: VisibilitySettingDef = {
  key: 'reviews',
  label: 'Reviews and ratings',
  helpText: 'Review text and stars, company averages, and sorting by rating. Reviewers\' names are always for signed-in members only.',
  defaultVisibility: 'public',
};

/** Shown in place of a reviewer's display name to anyone not signed in. */
export const MASKED_NAME = '[Masked]';

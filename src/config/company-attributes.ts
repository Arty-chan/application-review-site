/**
 * Single source of truth for what's known about a company's hiring process, and
 * who gets to see it:
 *
 * - companyAttributes: tri-state facts about the company itself (Yes / No /
 *   Unknown), set on the add/edit company form.
 * - reviewReports: things reviewers report by ticking a box on their review,
 *   shown on each company as the number of reviewers who reported it.
 * - reviewsConfig: who can read the reviews themselves.
 *
 * The company page, the search results, the search filters, and the forms all
 * loop over these lists rather than naming fields individually — so changing who
 * can see something is a one-word change to its `visibility` here, instead of a
 * hunt through templates and query code.
 *
 * IMPORTANT: this has to be enforced server-side too, not just in what the UI
 * renders. The search route checks visibility before honoring a filter param, so
 * a hidden item can't be filtered on by typing the param into the URL; and the
 * company form only shows and saves the attributes its editor can see.
 */

/** Who can see something: anyone, any signed-in user, or admins only. */
export type Visibility = 'public' | 'user' | 'admin';

/** The signed-in user, or null/undefined for an anonymous visitor. */
type Viewer = { role: 'user' | 'admin' } | null | undefined;

export function canView(visibility: Visibility, viewer: Viewer): boolean {
  if (visibility === 'public') return true;
  if (visibility === 'user') return !!viewer;
  return viewer?.role === 'admin';
}

// ---------- Company attributes ----------

export interface CompanyAttributeDef {
  /** Matches the corresponding column name on companies in src/db/schema.ts */
  key:
    | 'hiresRemote'
    | 'listsSalary'
    | 'requiresTakeHome'
    | 'requires5PlusCalls'
    | 'requiresWorkTrial'
    | 'activelyHiring'
    | 'publicHiringProcess'
    | 'postsGhostJobs';
  label: string;
  /** Optional helper text shown next to the label — e.g. clarifying criteria */
  helpText?: string;
  /** Who can see this attribute's value — and, since it's on the company form,
   * who can see and change it there. */
  visibility: Visibility;
  /** How the search can filter on it: 'require' shows only companies where it's
   * Yes; 'exclude' hides companies where it's Yes. */
  filter: 'require' | 'exclude' | null;
}

export const companyAttributes: CompanyAttributeDef[] = [
  { key: 'hiresRemote', label: 'Hires remote', visibility: 'public', filter: 'require' },
  { key: 'listsSalary', label: 'Lists salary', visibility: 'public', filter: 'require' },
  { key: 'requiresTakeHome', label: 'Requires take-home', visibility: 'public', filter: 'exclude' },
  { key: 'requires5PlusCalls', label: 'Requires 5+ calls', visibility: 'public', filter: 'exclude' },
  { key: 'requiresWorkTrial', label: 'Requires work trial', visibility: 'public', filter: 'exclude' },
  {
    key: 'activelyHiring',
    label: 'Actively hiring',
    helpText: 'Criteria: 5+ roles currently open',
    visibility: 'public',
    filter: 'require',
  },
  {
    key: 'publicHiringProcess',
    label: 'Publishes hiring process',
    helpText: 'Whether the stages are listed on the job description or website — not what they are',
    visibility: 'public',
    filter: 'require',
  },
  {
    key: 'postsGhostJobs',
    label: 'Posts ghost jobs',
    helpText: 'Job listings for roles that aren\'t actually being filled',
    visibility: 'public',
    filter: 'exclude',
  },
];

export function visibleAttributes(viewer: Viewer): CompanyAttributeDef[] {
  return companyAttributes.filter((a) => canView(a.visibility, viewer));
}

// ---------- Review reports ----------

export interface ReviewReportDef {
  /** Matches the corresponding boolean column on reviews in src/db/schema.ts */
  key: 'noReplyAfterApplication' | 'noReplyAfterCall';
  label: string;
  /** Who can see how many reviewers reported this for a company, and the report
   * on individual reviews (which also need reviewsConfig's visibility). Any
   * reviewer can still report it — this only limits who sees it. */
  visibility: Visibility;
}

export const reviewReports: ReviewReportDef[] = [
  { key: 'noReplyAfterApplication', label: 'No reply after application', visibility: 'public' },
  { key: 'noReplyAfterCall', label: 'No reply after a call', visibility: 'public' },
];

export function visibleReviewReports(viewer: Viewer): ReviewReportDef[] {
  return reviewReports.filter((r) => canView(r.visibility, viewer));
}

// ---------- Reviews ----------

export const reviewsConfig: { visibility: Visibility } = {
  /** Who can read reviews: their text and star ratings, each company's average
   * rating, and sorting the search by rating. Anyone signed in can still write
   * one — this only limits who reads them. Reviewers' display names are a
   * separate, fixed rule: signed-in users only (see MASKED_NAME). */
  visibility: 'public',
};

export function canViewReviews(viewer: Viewer): boolean {
  return canView(reviewsConfig.visibility, viewer);
}

/** Shown in place of a reviewer's display name to anyone not signed in. */
export const MASKED_NAME = '[Masked]';

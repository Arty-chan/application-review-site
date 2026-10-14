import { Router, type Response } from 'express';
import { z } from 'zod';
import { eq, and, or, isNull, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { db, transaction } from '../db/client.js';
import {
  companies, companyCountries, companyIndustries, countries, industries, reviews, users, favorites, employeeSizeRanges,
} from '../db/schema.js';
import { requireAuth, type CurrentUser } from '../middleware/auth.js';
import { normalizeUrl, registrableDomain } from '../lib/domain.js';
import {
  getRegionTree, descendantCountryCodes, groupCountriesByRegion, summarizeCountryGroups, type RegionTreeNode,
} from '../lib/regions.js';
import { pageLinks } from '../lib/pagination.js';
import {
  companyAttributes, reviewReports, type ReviewReportDef, MASKED_NAME,
} from '../config/company-attributes.js';
import {
  visibleAttributes, visibleReviewReports, reviewVisibility, canViewReviews, companyNotesVisibility, canViewCompanyNotes,
} from '../lib/visibility.js';

export const companiesRouter = Router();

const PAGE_SIZE = 30;

// Normalizes an HTML checkbox group to always be a string array — a single
// checked box submits as a plain string, not a one-element array, so this
// has to handle both shapes rather than assuming the array form.
const stringOrArray = z.union([z.string(), z.array(z.string())]).optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter((s) => s !== ''));

function parseQueryList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(',').filter(Boolean);
  if (Array.isArray(v)) return v.map(String);
  return [];
}

interface CompanyMeta {
  countries: { code: string; name: string }[];
  industries: { id: number; name: string }[];
  /** Out of 5, over the reviews that gave a rating (it's optional). */
  avgRating: number | null;
  ratingCount: number;
  /** Review reports the viewer can see that at least one reviewer made, with how many did. */
  reports: { label: string; count: number }[];
}

/** Batch-loads countries/industries/review stats for a page of companies — a
 * handful of IN-based queries regardless of page size, not one query per company.
 * Ratings follow the reviews' visibility; review report counts follow each
 * report's own (see src/lib/visibility.ts). */
async function loadCompanyMeta(companyIds: number[], viewer: CurrentUser | undefined): Promise<Map<number, CompanyMeta>> {
  const meta = new Map<number, CompanyMeta>();
  for (const id of companyIds) {
    meta.set(id, { countries: [], industries: [], avgRating: null, ratingCount: 0, reports: [] });
  }
  if (companyIds.length === 0) return meta;

  const countryRows = await db.select({
    companyId: companyCountries.companyId,
    code: countries.code,
    name: countries.name,
  }).from(companyCountries)
    .innerJoin(countries, eq(companyCountries.countryCode, countries.code))
    .where(inArray(companyCountries.companyId, companyIds));
  for (const row of countryRows) {
    meta.get(row.companyId)?.countries.push({ code: row.code, name: row.name });
  }

  const industryRows = await db.select({
    companyId: companyIndustries.companyId,
    id: industries.id,
    name: industries.name,
  }).from(companyIndustries)
    .innerJoin(industries, eq(companyIndustries.industryId, industries.id))
    .where(inArray(companyIndustries.companyId, companyIds));
  for (const row of industryRows) {
    meta.get(row.companyId)?.industries.push({ id: row.id, name: row.name });
  }

  // Summing a report's 0/1 column counts the reviews that ticked it.
  const reportCounts = Object.fromEntries(
    reviewReports.map((r) => [r.key, sql<number>`sum(${reviews[r.key]})`]),
  ) as Record<ReviewReportDef['key'], SQL<number>>;
  const statRows = await db.select({
    companyId: reviews.companyId,
    // Both skip unrated reviews (a null rating).
    avgRating: sql<number | null>`avg(${reviews.rating})`,
    ratingCount: sql<number>`count(${reviews.rating})`,
    ...reportCounts,
  }).from(reviews)
    .where(inArray(reviews.companyId, companyIds))
    .groupBy(reviews.companyId);

  const visibleReports = visibleReviewReports(viewer);
  for (const row of statRows) {
    const entry = meta.get(row.companyId);
    if (!entry) continue;
    if (canViewReviews(viewer) && row.avgRating !== null) {
      entry.avgRating = row.avgRating / 2; // stored in half-star units
      entry.ratingCount = row.ratingCount;
    }
    entry.reports = visibleReports
      .map((r) => ({ label: r.label, count: row[r.key] }))
      .filter((r) => r.count > 0);
  }

  return meta;
}

/** Where a company hires, for display: whether that's everywhere, and its
 * countries grouped by region. */
function describeLocations(regionTree: RegionTreeNode[], countryCodes: Set<string>) {
  const hiresAnywhere = regionTree.flatMap(descendantCountryCodes).every((code) => countryCodes.has(code));
  return { hiresAnywhere, countryGroups: groupCountriesByRegion(regionTree, countryCodes, hiresAnywhere) };
}

// ---------- List / search ----------

companiesRouter.get('/', async (req, res) => {
  const viewer = req.currentUser;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(1, Number(req.query.page) || 1);
  const regionTree = await getRegionTree();

  const selectedCountries = parseQueryList(req.query.country);
  const selectedIndustries = parseQueryList(req.query.industry).map(Number).filter((n) => !Number.isNaN(n));
  const selectedSize = typeof req.query.size === 'string' ? req.query.size : '';
  const selectedExclusions = parseQueryList(req.query.exclude);

  const conditions: (SQL | undefined)[] = [];

  if (q) {
    conditions.push(sql`lower(${companies.name}) LIKE lower(${'%' + q + '%'})`);
  }
  if (selectedCountries.length > 0) {
    const matching = db.select({ id: companyCountries.companyId }).from(companyCountries)
      .where(inArray(companyCountries.countryCode, selectedCountries));
    conditions.push(inArray(companies.id, matching));
  }
  if (selectedIndustries.length > 0) {
    const matching = db.select({ id: companyIndustries.companyId }).from(companyIndustries)
      .where(inArray(companyIndustries.industryId, selectedIndustries));
    conditions.push(inArray(companies.id, matching));
  }
  if ((employeeSizeRanges as readonly string[]).includes(selectedSize)) {
    conditions.push(eq(companies.employeeSizeRange, selectedSize as typeof employeeSizeRanges[number]));
  }

  // Attribute and review-report filters — only ever honored for what the current
  // viewer is actually allowed to see, checked server-side against the registry.
  // This is the enforcement the registry's own comment calls for: hiding a
  // checkbox in the UI is not enough on its own.
  const attributes = visibleAttributes(viewer);
  const reports = visibleReviewReports(viewer);
  for (const attr of attributes) {
    const column = companies[attr.key];
    if (attr.filter === 'require') {
      const raw = req.query[attr.key];
      if (raw === 'true') conditions.push(eq(column, true));
      if (raw === 'false') conditions.push(eq(column, false));
    } else if (attr.filter === 'exclude' && selectedExclusions.includes(attr.key)) {
      // Hides only a definite Yes — Unknown stays in.
      conditions.push(or(isNull(column), eq(column, false)));
    }
  }
  for (const report of reports) {
    if (selectedExclusions.includes(report.key)) {
      const reported = db.select({ id: reviews.companyId }).from(reviews).where(eq(reviews[report.key], true));
      conditions.push(notInArray(companies.id, reported));
    }
  }

  const whereClause = and(...conditions);

  // Alphabetical A–Z unless chosen otherwise. Only viewers who can see ratings
  // can sort by them — the order would give them away.
  const canSeeReviews = canViewReviews(viewer);
  const sort = req.query.sort === 'updated' ? 'updated'
    : (req.query.sort === 'rating' || req.query.sort === 'ratingCount') && canSeeReviews ? req.query.sort
    : 'name';
  const order = req.query.order === 'desc' ? 'desc' : 'asc';
  const direction = sql.raw(order.toUpperCase());
  const byName = sql`${companies.name} COLLATE NOCASE`;
  // Ties go A–Z.
  const orderBy = {
    name: [sql`${byName} ${direction}`],
    updated: [sql`${companies.updatedAt} ${direction}`, byName],
    // Companies without a rating come last either way.
    rating: [sql`(SELECT avg(r.rating) FROM reviews r WHERE r.company_id = ${companies.id}) ${direction} NULLS LAST`, byName],
    // Unrated reviews don't count (see loadCompanyMeta).
    ratingCount: [sql`(SELECT count(r.rating) FROM reviews r WHERE r.company_id = ${companies.id}) ${direction}`, byName],
  }[sort];

  const [rows, totalRows] = await Promise.all([
    db.select().from(companies).where(whereClause).orderBy(...orderBy)
      .limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)` }).from(companies).where(whereClause),
  ]);
  const total = totalRows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const meta = await loadCompanyMeta(rows.map((c) => c.id), viewer);

  res.render('companies/list', {
    companies: rows.map((c) => {
      const companyMeta = meta.get(c.id)!;
      const { hiresAnywhere, countryGroups } = describeLocations(regionTree, new Set(companyMeta.countries.map((x) => x.code)));
      // Cards show the compact version; the company page has the full list.
      return { ...c, ...companyMeta, hiresAnywhere, regionSummary: summarizeCountryGroups(countryGroups) };
    }),
    q,
    page,
    totalPages,
    pages: pageLinks(page, totalPages),
    regionTree,
    allIndustries: await db.select().from(industries),
    employeeSizes: employeeSizeRanges,
    attributes,
    requireFilters: attributes.filter((a) => a.filter === 'require'),
    excludeAttributes: attributes.filter((a) => a.filter === 'exclude'),
    excludeReports: reports,
    canSeeReviews,
    selected: {
      countries: selectedCountries,
      industries: selectedIndustries,
      size: selectedSize,
      exclude: selectedExclusions,
      sort,
      order,
      query: req.query,
    },
  });
});

// ---------- Add / edit forms share the same field set ----------

const triState = z.enum(['true', 'false', '']).optional()
  .transform((v) => (v === 'true' ? true : v === 'false' ? false : null));

const companyFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  websiteUrl: z.string().trim().min(1, 'Website URL is required'),
  careersUrl: z.string().trim().optional(),
  employeeSizeRange: z.enum([...employeeSizeRanges, ''], {
    error: `Employee size must be one of: ${employeeSizeRanges.join(', ')}.`,
  }).optional(),
  generalNotes: z.string().max(2000).optional(),
  hiresRemote: triState,
  listsSalary: triState,
  requiresTakeHome: triState,
  requires5PlusCalls: triState,
  requiresWorkTrial: triState,
  activelyHiring: triState,
  publicHiringProcess: triState,
  postsGhostJobs: triState,
  countries: stringOrArray,
  industries: stringOrArray,
  newIndustry: z.string().trim().max(60).optional(),
}).strict();

/** The form only offers the attributes (and notes) its editor is allowed to see. */
async function renderCompanyForm(
  res: Response,
  editor: CurrentUser,
  opts: { error?: string; values?: object; companyId?: number } = {},
) {
  res.status(opts.error ? 400 : 200).render('companies/form', {
    ...opts,
    regionTree: await getRegionTree(),
    allIndustries: await db.select().from(industries),
    employeeSizes: employeeSizeRanges,
    attributes: visibleAttributes(editor),
    notesVisibility: canViewCompanyNotes(editor) ? companyNotesVisibility() : null,
  });
}

type SaveResult = { ok: true; id: number } | { ok: false; error: string };

/** Validates a submitted add/edit form and normalizes it into column values,
 * plus what to link it to. No database access. */
function parseCompanyForm(body: unknown, editor: CurrentUser) {
  const parsed = companyFormSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'Invalid submission.' };
  }
  const {
    countries: countryCodes, industries: industryIdList, newIndustry,
    name, websiteUrl: rawWebsiteUrl, careersUrl, employeeSizeRange, generalNotes,
    ...attributeValues
  } = parsed.data;

  const websiteUrl = normalizeUrl(rawWebsiteUrl);
  const websiteDomain = registrableDomain(websiteUrl);
  if (!websiteDomain) return { ok: false as const, error: 'That website URL doesn\'t look valid.' };

  // Only the attributes (and notes) the editor can see were on their form; the
  // rest are left as they are rather than overwritten with "unknown" (or blank).
  const attributes = Object.fromEntries(
    visibleAttributes(editor).map((a) => [a.key, attributeValues[a.key]]),
  ) as Partial<typeof attributeValues>;
  const notes = canViewCompanyNotes(editor) ? { generalNotes: generalNotes || null } : {};

  return {
    ok: true as const,
    values: {
      name,
      ...attributes,
      websiteUrl,
      websiteDomain,
      careersUrl: careersUrl ? normalizeUrl(careersUrl) : null,
      employeeSizeRange: employeeSizeRange || null,
      ...notes,
    },
    countryCodes,
    industryIds: industryIdList.map(Number).filter((n) => !Number.isNaN(n)),
    newIndustry,
  };
}

/** Saves a submitted add/edit form — pass companyId to update that company,
 * omit it to create one. Everything it writes (the company, an inline new
 * industry, the country/industry links) is one transaction: if any part fails,
 * none of it is saved. Also used by the CSV import, one row at a time. */
export function saveCompany(body: unknown, editor: CurrentUser, companyId?: number): SaveResult {
  const form = parseCompanyForm(body, editor);
  if (!form.ok) return form;

  return transaction((tx): SaveResult => {
    // Checked inside the transaction so nothing can claim the domain between
    // this check and the write below.
    const existing = tx.query.companies.findFirst({ where: eq(companies.websiteDomain, form.values.websiteDomain) }).sync();
    if (existing && existing.id !== companyId) {
      return { ok: false, error: `A company with this website already exists: "${existing.name}".` };
    }

    const industryIds = [...form.industryIds];
    if (form.newIndustry) {
      const row = tx.insert(industries).values({ name: form.newIndustry })
        .onConflictDoUpdate({ target: industries.name, set: { name: form.newIndustry } })
        .returning().get();
      industryIds.push(row.id);
    }

    const values = { ...form.values, updatedBy: editor.id, updatedAt: new Date() };
    let id = companyId;
    if (id === undefined) {
      id = tx.insert(companies).values(values).returning({ id: companies.id }).get().id;
    } else {
      tx.update(companies).set(values).where(eq(companies.id, id)).run();
    }

    // Replace the link sets rather than diff them — simplest correct way to sync
    // a many-to-many from a full-form submit, and fine at this data size.
    tx.delete(companyCountries).where(eq(companyCountries.companyId, id)).run();
    tx.delete(companyIndustries).where(eq(companyIndustries.companyId, id)).run();
    if (form.countryCodes.length > 0) {
      tx.insert(companyCountries).values(form.countryCodes.map((countryCode) => ({ companyId: id, countryCode }))).run();
    }
    if (industryIds.length > 0) {
      tx.insert(companyIndustries).values(industryIds.map((industryId) => ({ companyId: id, industryId }))).run();
    }

    return { ok: true, id };
  });
}

companiesRouter.get('/companies/new', requireAuth, async (req, res) => {
  await renderCompanyForm(res, req.currentUser!);
});

companiesRouter.post('/companies', requireAuth, async (req, res) => {
  const saved = saveCompany(req.body, req.currentUser!);
  if (!saved.ok) return renderCompanyForm(res, req.currentUser!, { error: saved.error, values: req.body });
  res.redirect(`/companies/${saved.id}`);
});

companiesRouter.get('/companies/:id/edit', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const company = await db.query.companies.findFirst({ where: eq(companies.id, id) });
  if (!company) return res.status(404).render('errors/404');

  const own = (await loadCompanyMeta([id], req.currentUser)).get(id)!;

  await renderCompanyForm(res, req.currentUser!, {
    companyId: id,
    values: {
      ...company,
      // Tri-state attributes as the form's select values: 'true', 'false', or '' (unknown).
      ...Object.fromEntries(companyAttributes.map((a) => [a.key, String(company[a.key] ?? '')])),
      countries: own.countries.map((c) => c.code),
      industries: own.industries.map((i) => String(i.id)),
    },
  });
});

companiesRouter.post('/companies/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const company = await db.query.companies.findFirst({ where: eq(companies.id, id) });
  if (!company) return res.status(404).render('errors/404');

  const saved = saveCompany(req.body, req.currentUser!, id);
  if (!saved.ok) return renderCompanyForm(res, req.currentUser!, { companyId: id, error: saved.error, values: req.body });
  res.redirect(`/companies/${id}`);
});

// ---------- Detail (mounted after /companies/new etc. so :id doesn't shadow them) ----------

companiesRouter.get('/companies/:id', async (req, res) => {
  const id = Number(req.params.id);
  const company = await db.query.companies.findFirst({ where: eq(companies.id, id) });
  if (!company) return res.status(404).render('errors/404');

  const viewer = req.currentUser;
  const isAuthed = !!viewer;
  const meta = (await loadCompanyMeta([id], viewer)).get(id)!;

  const { hiresAnywhere, countryGroups } = describeLocations(await getRegionTree(), new Set(meta.countries.map((c) => c.code)));
  const isFavorite = viewer
    ? !!await db.query.favorites.findFirst({ where: and(eq(favorites.userId, viewer.id), eq(favorites.companyId, id)) })
    : false;

  // Who last edited the company is for signed-in users only.
  const updatedByUser = isAuthed && company.updatedBy
    ? await db.query.users.findFirst({ where: eq(users.id, company.updatedBy) })
    : null;
  // Reviews follow their visibility setting. Reviewers' names are for
  // signed-in users only: anyone else gets MASKED_NAME, decided here so the
  // names never reach their page at all.
  const canSeeReviews = canViewReviews(viewer);
  const companyReviews = canSeeReviews
    ? (await db.query.reviews.findMany({
      where: eq(reviews.companyId, id),
      orderBy: (r, { desc }) => [desc(r.createdAt)],
      with: { user: { columns: { displayName: true } } },
    })).map(({ user, deletedUserDisplayName, ...review }) => ({
      ...review,
      authorName: isAuthed ? (user ? user.displayName : deletedUserDisplayName) : MASKED_NAME,
    }))
    : [];

  res.render('companies/detail', {
    company,
    meta,
    hiresAnywhere,
    countryGroups,
    isFavorite,
    updatedByUser,
    isAuthed,
    canSeeReviews,
    canSeeNotes: canViewCompanyNotes(viewer),
    reviewVisibility: reviewVisibility(),
    reviews: companyReviews,
    myReview: companyReviews.find((r) => r.userId === viewer?.id),
    today: new Date().toISOString().slice(0, 10),
    visibleAttrs: visibleAttributes(viewer).map((a) => ({ ...a, value: company[a.key] })),
    // Every report is on the review form; only visible ones are shown on reviews.
    reviewReports,
    visibleReports: visibleReviewReports(viewer),
  });
});

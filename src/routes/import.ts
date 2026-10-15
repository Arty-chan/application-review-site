import { Router, type Response } from 'express';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { asc, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  companies, companyCountries, companyIndustries, countries, industries, employeeSizeRanges,
} from '../db/schema.js';
import { requireAdmin, requireLevel, type CurrentUser } from '../middleware/auth.js';
import { getRegionTree, descendantCountryCodes, type RegionTreeNode } from '../lib/regions.js';
import { visibilityOf } from '../lib/visibility.js';
import { companyAttributes, importPageSetting } from '../config/company-attributes.js';
import { saveCompany } from './companies.js';

export const importRouter = Router();

// The Import page: bulk-adds companies from pasted CSV — a header row naming
// the columns, then one company per row. Each row is turned into the same fields
// the add-company form submits and saved with saveCompany() — so imported
// companies are validated and saved exactly like ones added by hand, each row in
// its own transaction. Admins can also export every company there, in the same
// columns.

/** A company with what the export needs alongside it. */
interface ExportRow {
  company: typeof companies.$inferSelect;
  hiresAnywhere: boolean;
  countryCodes: string[];
  industryNames: string[];
}

const yesNo = (value: boolean | null) => (value === true ? 'yes' : value === false ? 'no' : '');

/** The CSV columns: what each accepts when importing, and its value when exporting. */
export const csvColumns: { name: string; description: string; exportValue: (row: ExportRow) => string }[] = [
  { name: 'name', description: 'Required.', exportValue: (r) => r.company.name },
  { name: 'websiteUrl', description: 'Required, e.g. acme.com.', exportValue: (r) => r.company.websiteUrl },
  { name: 'careersUrl', description: 'e.g. acme.com/careers', exportValue: (r) => r.company.careersUrl ?? '' },
  {
    name: 'employeeSizeRange',
    description: `One of: ${employeeSizeRanges.join(', ')}`,
    exportValue: (r) => r.company.employeeSizeRange ?? '',
  },
  {
    name: 'location',
    description: 'One country (name or code, e.g. Germany or DE), one region (e.g. EMEA or Europe), or "anywhere". Blank means anywhere.',
    exportValue: (r) => (r.hiresAnywhere ? 'anywhere' : r.countryCodes.join(', ')),
  },
  {
    name: 'industry',
    description: 'One industry. Names not listed yet are added.',
    exportValue: (r) => r.industryNames.join(', '),
  },
  { name: 'generalNotes', description: 'Free text.', exportValue: (r) => r.company.generalNotes ?? '' },
  ...companyAttributes.map((a) => ({
    name: a.key,
    description: `${a.label}: yes, no, or blank for unknown.`,
    exportValue: (r: ExportRow) => yesNo(r.company[a.key]),
  })),
];
const columnNames = csvColumns.map((c) => c.name);
const headerRow = columnNames.join(',');
const requiredColumns = ['name', 'websiteUrl'];

const triStateValues = new Map([['yes', 'true'], ['no', 'false'], ['', '']]);

/** Why a header row can't be used, or null if it's fine. */
function headerProblem(header: string[]): string | null {
  const unknown = header.filter((c) => !columnNames.includes(c));
  if (unknown.length > 0) return `These columns aren't recognized: ${unknown.join(', ')}. The column names are listed above.`;
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length > 0) return `These required columns are missing: ${missing.join(', ')}.`;
  if (new Set(header).size !== header.length) return 'Each column can only appear once.';
  return null;
}

/** Every value the location column accepts, lowercased, mapped to the country
 * codes it stands for — or to null if it names more than one place. */
function locationLookup(tree: RegionTreeNode[]): Map<string, string[] | null> {
  const lookup = new Map<string, string[] | null>();
  const add = (name: string, codes: string[]) => {
    const key = name.toLowerCase();
    lookup.set(key, lookup.has(key) ? null : codes);
  };
  const addRegion = (region: RegionTreeNode) => {
    add(region.name, descendantCountryCodes(region));
    for (const country of region.countries) {
      add(country.code, [country.code]);
      add(country.name, [country.code]);
    }
    region.children.forEach(addRegion);
  };
  add('anywhere', tree.flatMap(descendantCountryCodes));
  tree.forEach(addRegion);
  return lookup;
}

/** Matches industry names case-insensitively, against existing industries and
 * new ones earlier in the same import, so "fintech" and "FinTech" end up as one. */
async function industryNamer(): Promise<(name: string) => string> {
  const names = new Map((await db.select().from(industries)).map((i) => [i.name.toLowerCase(), i.name]));
  return (name) => {
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
    return names.get(key)!;
  };
}

type Row = Partial<Record<string, string>>;

/** One CSV row as the fields the add-company form would submit. */
function rowToForm(row: Row, locations: Map<string, string[] | null>, industryName: (name: string) => string) {
  const location = row.location || 'anywhere';
  const countries = locations.get(location.toLowerCase());
  if (countries === undefined) return { ok: false as const, error: `Unknown location "${location}".` };
  if (countries === null) return { ok: false as const, error: `Location "${location}" matches more than one place.` };

  const attributes: Record<string, string> = {};
  for (const attr of companyAttributes) {
    const value = triStateValues.get((row[attr.key] ?? '').toLowerCase());
    if (value === undefined) return { ok: false as const, error: `${attr.key} must be yes, no, or blank.` };
    attributes[attr.key] = value;
  }

  return {
    ok: true as const,
    form: {
      name: row.name,
      websiteUrl: row.websiteUrl,
      careersUrl: row.careersUrl,
      employeeSizeRange: row.employeeSizeRange,
      generalNotes: row.generalNotes,
      countries,
      // The form's "add a new industry" field links an existing industry of the
      // same name, or creates it.
      newIndustry: row.industry ? industryName(row.industry) : undefined,
      ...attributes,
    },
  };
}

interface ImportResult {
  name: string;
  ok: boolean;
  id?: number;
  error?: string;
}

/** What the Import page shows after an import: why the CSV couldn't be used
 * (alongside it, to fix), or how each row went. */
export type ImportOutcome = { csv: string; error: string } | { results: ImportResult[] };

export async function importCompanies(csv: string, user: CurrentUser): Promise<ImportOutcome> {
  let rows: string[][];
  try {
    rows = parse(csv, { bom: true, trim: true, skip_empty_lines: true });
  } catch (err) {
    return { csv, error: `That couldn't be read as CSV: ${(err as Error).message}` };
  }
  const [header = [], ...records] = rows;
  const problem = headerProblem(header) ?? (records.length === 0 ? 'There are no companies below the header row.' : null);
  if (problem) return { csv, error: problem };

  const locations = locationLookup(await getRegionTree());
  const industryName = await industryNamer();

  const results: ImportResult[] = records.map((record) => {
    const row: Row = Object.fromEntries(header.map((column, i) => [column, record[i]]));
    const prepared = rowToForm(row, locations, industryName);
    const saved = prepared.ok ? saveCompany(prepared.form, user) : prepared;
    return { name: row.name || '(no name)', ...saved };
  });
  return { results };
}

// ---------- Export ----------

/** A CSV field, in double quotes if it contains a comma, quote or line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Every company as CSV, A–Z. Pass column names to export just those. */
export async function companiesCsv(columns: string[] = columnNames): Promise<string> {
  const [allCompanies, countryLinks, industryLinks, [{ countryCount }]] = await Promise.all([
    db.select().from(companies).orderBy(asc(companies.name)),
    db.select().from(companyCountries),
    db.select({ companyId: companyIndustries.companyId, name: industries.name })
      .from(companyIndustries).innerJoin(industries, eq(companyIndustries.industryId, industries.id)),
    db.select({ countryCount: count() }).from(countries),
  ]);
  const exported = csvColumns.filter((c) => columns.includes(c.name));

  const lines = allCompanies.map((company) => {
    const countryCodes = countryLinks.filter((l) => l.companyId === company.id).map((l) => l.countryCode).sort();
    const row: ExportRow = {
      company,
      hiresAnywhere: countryCodes.length > 0 && countryCodes.length === countryCount,
      countryCodes,
      industryNames: industryLinks.filter((l) => l.companyId === company.id).map((l) => l.name).sort(),
    };
    return exported.map((c) => csvField(c.exportValue(row))).join(',');
  });
  // Starts with a byte-order mark, so Excel reads it as UTF-8 (the import skips it).
  return '\uFEFF' + [exported.map((c) => c.name).join(','), ...lines].join('\n') + '\n';
}

// ---------- Routes ----------

/** The Import page is for whoever the admin Settings allow — never anyone signed out. */
const requireImportAccess = requireLevel(() => visibilityOf(importPageSetting));

function renderImportPage(res: Response, outcome?: ImportOutcome) {
  res.status(outcome && 'error' in outcome ? 400 : 200).render('companies/import', {
    csvColumns, headerRow, csvImport: outcome,
  });
}

importRouter.get('/import', requireImportAccess, (_req, res) => {
  renderImportPage(res);
});

const importSchema = z.object({ csv: z.string().trim().min(1, 'Paste the CSV to import.') }).strict();

importRouter.post('/import', requireImportAccess, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return renderImportPage(res, { csv: '', error: parsed.error.issues[0]?.message ?? 'Invalid submission.' });
  renderImportPage(res, await importCompanies(parsed.data.csv, req.currentUser!));
});

// Admins only, whoever the Import page itself is open to.
importRouter.get('/import/export.csv', requireAdmin, async (_req, res) => {
  res.attachment('companies.csv').send(await companiesCsv());
});

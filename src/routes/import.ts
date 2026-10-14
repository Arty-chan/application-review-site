import { Router, type Response } from 'express';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { db } from '../db/client.js';
import { industries, employeeSizeRanges } from '../db/schema.js';
import { requireAdmin } from '../middleware/auth.js';
import { getRegionTree, descendantCountryCodes, type RegionTreeNode } from '../lib/regions.js';
import { companyAttributes } from '../config/company-attributes.js';
import { saveCompany } from './companies.js';

export const importRouter = Router();

// Bulk-adds companies from pasted CSV: a header row naming the columns, then one
// company per row. Each row is turned into the same fields the add-company form
// submits and saved with saveCompany() — so imported companies are validated and
// saved exactly like ones added by hand, each row in its own transaction.

const columns = [
  { name: 'name', description: 'Required.' },
  { name: 'websiteUrl', description: 'Required, e.g. acme.com.' },
  { name: 'careersUrl', description: 'e.g. acme.com/careers' },
  { name: 'employeeSizeRange', description: `One of: ${employeeSizeRanges.join(', ')}` },
  {
    name: 'location',
    description: 'One country (name or code, e.g. Germany or DE), one region (e.g. EMEA or Europe), or "anywhere". Blank means anywhere.',
  },
  { name: 'industry', description: 'One industry. Names not listed yet are added.' },
  { name: 'generalNotes', description: 'Visible to signed-in users only.' },
  ...companyAttributes.map((a) => ({ name: a.key, description: `${a.label}: yes, no, or blank for unknown.` })),
];
const columnNames = columns.map((c) => c.name);
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

function renderImportPage(res: Response, opts: { csv?: string; error?: string; results?: ImportResult[] } = {}) {
  res.status(opts.error ? 400 : 200).render('admin/import', { ...opts, columns, headerRow: columnNames.join(',') });
}

importRouter.get('/admin/import', requireAdmin, (_req, res) => {
  renderImportPage(res);
});

const importSchema = z.object({ csv: z.string().trim().min(1, 'Paste the CSV to import.') }).strict();

importRouter.post('/admin/import', requireAdmin, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return renderImportPage(res, { error: parsed.error.issues[0]?.message });
  const { csv } = parsed.data;

  let rows: string[][];
  try {
    rows = parse(csv, { bom: true, trim: true, skip_empty_lines: true });
  } catch (err) {
    return renderImportPage(res, { csv, error: `That couldn't be read as CSV: ${(err as Error).message}` });
  }
  const [header = [], ...records] = rows;
  const problem = headerProblem(header) ?? (records.length === 0 ? 'There are no companies below the header row.' : null);
  if (problem) return renderImportPage(res, { csv, error: problem });

  const locations = locationLookup(await getRegionTree());
  const industryName = await industryNamer();

  const results: ImportResult[] = records.map((record) => {
    const row: Row = Object.fromEntries(header.map((column, i) => [column, record[i]]));
    const prepared = rowToForm(row, locations, industryName);
    const saved = prepared.ok ? saveCompany(prepared.form, req.currentUser!) : prepared;
    return { name: row.name || '(no name)', ...saved };
  });

  renderImportPage(res, { results });
});

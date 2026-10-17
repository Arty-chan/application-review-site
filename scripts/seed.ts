import '../src/lib/load-env.js';
import { readFileSync } from 'node:fs';
import { eq, and, isNull, inArray, notInArray } from 'drizzle-orm';
import { transaction, type Transaction } from '../src/db/client.js';
import { regions, countries, companyCountries, industries } from '../src/db/schema.js';

// Makes the database's regions and countries match scripts/data/regions.json
// exactly — adding, moving, renaming and removing — so it's safe to rerun after
// editing the file. All in one transaction: it fully applies or changes nothing.
//
// Industries are only ever added, never removed: users can add their own from
// the company form, so one missing from industries.json may still be in use.

interface RegionNode {
  name: string;
  children?: RegionNode[];
  countries?: { code: string; name: string }[];
}

function readData<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./data/${file}`, import.meta.url), 'utf-8'));
}

/** Adds or updates every region and country in the tree, recording what the file contains. */
function syncTree(tx: Transaction, nodes: RegionNode[], parentId: number | null, inFile: { regionIds: number[]; codes: string[] }) {
  for (const node of nodes) {
    const existing = tx.query.regions.findFirst({
      where: and(eq(regions.name, node.name), parentId === null ? isNull(regions.parentId) : eq(regions.parentId, parentId)),
    }).sync();
    const regionId = existing?.id ?? tx.insert(regions).values({ name: node.name, parentId }).returning().get().id;
    inFile.regionIds.push(regionId);

    for (const country of node.countries ?? []) {
      tx.insert(countries).values({ ...country, regionId })
        .onConflictDoUpdate({ target: countries.code, set: { name: country.name, regionId } })
        .run();
      inFile.codes.push(country.code);
    }

    syncTree(tx, node.children ?? [], regionId, inFile);
  }
}

/** Every country code under a region in the file, sub-regions included. */
function codesUnder(node: RegionNode): string[] {
  return [...(node.countries ?? []).map((c) => c.code), ...(node.children ?? []).flatMap(codesUnder)];
}

/** The region a country sits in directly. */
function regionOf(nodes: RegionNode[], code: string): RegionNode | undefined {
  for (const node of nodes) {
    if (node.countries?.some((c) => c.code === code)) return node;
    const found = regionOf(node.children ?? [], code);
    if (found) return found;
  }
  return undefined;
}

const regionTree = readData<RegionNode[]>('regions.json');
const industryNames = readData<string[]>('industries.json');

try {
  const result = transaction((tx) => {
    const inFile = { regionIds: [] as number[], codes: [] as string[] };
    const codesBefore = new Set(tx.select({ code: countries.code }).from(countries).all().map((c) => c.code));
    syncTree(tx, regionTree, null, inFile);

    // Anything not in the file any more is removed — except a country a company
    // still lists, which would silently lose data: stop instead (rolling back).
    const removedCodes = tx.select({ code: countries.code }).from(countries)
      .where(notInArray(countries.code, inFile.codes)).all().map((c) => c.code);
    const inUse = tx.selectDistinct({ code: companyCountries.countryCode }).from(companyCountries)
      .where(inArray(companyCountries.countryCode, removedCodes)).all().map((c) => c.code);
    if (inUse.length > 0) {
      throw new Error(
        `These countries aren't in regions.json any more, but companies still list them: ${inUse.join(', ')}. `
        + 'Put them back in the file, or remove them from those companies first. Nothing was changed.',
      );
    }
    tx.delete(countries).where(notInArray(countries.code, inFile.codes)).run();

    // Full paths (e.g. "AMER > LATAM > Central America"), so a removed old region
    // can't be mistaken for a same-named one that's still there.
    const regionById = new Map(tx.select().from(regions).all().map((r) => [r.id, r]));
    const pathOf = (id: number): string => {
      const region = regionById.get(id)!;
      return region.parentId === null ? region.name : `${pathOf(region.parentId)} > ${region.name}`;
    };
    const removedRegions = [...regionById.keys()].filter((id) => !inFile.regionIds.includes(id)).map(pathOf);
    tx.delete(regions).where(notInArray(regions.id, inFile.regionIds)).run();

    // A company that lists every country of a region — all of the Caribbean, say,
    // or anywhere at all — gets that region's new countries too, so it still
    // covers the whole region.
    const added = inFile.codes.filter((code) => !codesBefore.has(code));
    const codesByCompany = new Map<number, Set<string>>();
    for (const { companyId, countryCode } of tx.select().from(companyCountries).all()) {
      if (!codesByCompany.has(companyId)) codesByCompany.set(companyId, new Set());
      codesByCompany.get(companyId)!.add(countryCode);
    }
    let linksAdded = 0;
    for (const code of added) {
      const others = codesUnder(regionOf(regionTree, code)!).filter((c) => !added.includes(c));
      if (others.length === 0) continue;
      for (const [companyId, codes] of codesByCompany) {
        if (others.every((c) => codes.has(c))) {
          tx.insert(companyCountries).values({ companyId, countryCode: code }).run();
          linksAdded += 1;
        }
      }
    }

    for (const name of industryNames) {
      tx.insert(industries).values({ name }).onConflictDoNothing().run();
    }

    return { removedCodes, removedRegions, added, linksAdded, firstSeed: codesBefore.size === 0 };
  });

  console.log(`Regions and countries now match regions.json (${regionTree.length} top-level regions).`);
  if (result.removedRegions.length) console.log(`Removed regions no longer in the file: ${result.removedRegions.join(', ')}`);
  if (result.removedCodes.length) console.log(`Removed countries no longer in the file: ${result.removedCodes.join(', ')}`);
  if (result.added.length && !result.firstSeed) {
    console.log(`Added countries: ${result.added.join(', ')}. Companies covering their whole region now list them too (${result.linksAdded} added).`);
  }
  console.log(`Industries: ensured all ${industryNames.length} from industries.json exist.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}

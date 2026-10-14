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

const regionTree = readData<RegionNode[]>('regions.json');
const industryNames = readData<string[]>('industries.json');

try {
  const result = transaction((tx) => {
    const inFile = { regionIds: [] as number[], codes: [] as string[] };
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

    for (const name of industryNames) {
      tx.insert(industries).values({ name }).onConflictDoNothing().run();
    }

    return { removedCodes, removedRegions };
  });

  console.log(`Regions and countries now match regions.json (${regionTree.length} top-level regions).`);
  if (result.removedRegions.length) console.log(`Removed regions no longer in the file: ${result.removedRegions.join(', ')}`);
  if (result.removedCodes.length) console.log(`Removed countries no longer in the file: ${result.removedCodes.join(', ')}`);
  console.log(`Industries: ensured all ${industryNames.length} from industries.json exist.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}

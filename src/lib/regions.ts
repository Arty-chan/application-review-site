import { db } from '../db/client.js';
import { regions, countries } from '../db/schema.js';

export interface RegionTreeNode {
  id: number;
  name: string;
  children: RegionTreeNode[];
  countries: { code: string; name: string }[];
}

export async function getRegionTree(): Promise<RegionTreeNode[]> {
  const allRegions = await db.select().from(regions);
  const allCountries = await db.select().from(countries);

  const nodeById = new Map<number, RegionTreeNode>();
  for (const r of allRegions) {
    nodeById.set(r.id, { id: r.id, name: r.name, children: [], countries: [] });
  }
  for (const c of allCountries) {
    nodeById.get(c.regionId)?.countries.push({ code: c.code, name: c.name });
  }

  const roots: RegionTreeNode[] = [];
  for (const r of allRegions) {
    const node = nodeById.get(r.id)!;
    if (r.parentId === null) {
      roots.push(node);
    } else {
      nodeById.get(r.parentId)?.children.push(node);
    }
  }

  const sortTree = (nodes: RegionTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) {
      node.countries.sort((a, b) => a.name.localeCompare(b.name));
      sortTree(node.children);
    }
  };
  sortTree(roots);

  return roots;
}

export interface CountryGroup {
  name: string;
  /** Every country in this region is included (marked only on the outermost such
   * region, not again on each of its sub-regions). */
  whole: boolean;
  /** Included countries that sit directly in this region (not in a sub-region). */
  countries: string[];
  children: CountryGroup[];
}

/** The given countries arranged by region for display, leaving out regions that
 * contain none of them. Pass insideWholeRegion when the caller already says the
 * whole set is covered (e.g. "Anywhere"), so no region is marked whole again. */
export function groupCountriesByRegion(tree: RegionTreeNode[], codes: Set<string>, insideWholeRegion = false): CountryGroup[] {
  return tree.flatMap((node) => {
    const inRegion = descendantCountryCodes(node);
    const included = inRegion.filter((code) => codes.has(code)).length;
    if (included === 0) return [];
    const whole = included === inRegion.length;
    return [{
      name: node.name,
      whole: whole && !insideWholeRegion,
      countries: node.countries.filter((c) => codes.has(c.code)).map((c) => c.name),
      children: groupCountriesByRegion(node.children, codes, insideWholeRegion || whole),
    }];
  });
}

export interface RegionSummary {
  region: string;
  /** Every country in the region is included. */
  whole: boolean;
  /** The included countries' names. */
  countries: string[];
}

/** A compact, one-level version of groupCountriesByRegion's output for search
 * results: each wholly-included region (the outermost one), plus the most
 * specific region of every other included country. */
export function summarizeCountryGroups(groups: CountryGroup[]): RegionSummary[] {
  const allNames = (group: CountryGroup): string[] => [...group.countries, ...group.children.flatMap(allNames)];
  return groups.flatMap((group) => (group.whole
    ? [{ region: group.name, whole: true, countries: allNames(group) }]
    : [
      ...(group.countries.length ? [{ region: group.name, whole: false, countries: group.countries }] : []),
      ...summarizeCountryGroups(group.children),
    ]));
}

/** Every country code under a region node, recursively — what a region (or
 * "anywhere") stands for in the CSV import's location column, and how a company
 * page tells whether a whole region is covered. */
export function descendantCountryCodes(node: RegionTreeNode): string[] {
  const codes = node.countries.map((c) => c.code);
  for (const child of node.children) {
    codes.push(...descendantCountryCodes(child));
  }
  return codes;
}

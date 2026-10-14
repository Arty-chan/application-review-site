/** How many pages to link at each end of the list, and on each side of the current one. */
const EDGE = 2;
const AROUND = 1;

/**
 * The page numbers to link to, e.g. 1 2 … 9 [10] 11 … 49 50: the first and
 * last few pages, and the ones either side of the current page. null marks a
 * run of pages left out — unless it's a single page, which is shown instead,
 * since "…" would take its place anyway.
 */
export function pageLinks(current: number, total: number): (number | null)[] {
  const shown = new Set<number>();
  const addRange = (from: number, to: number) => {
    for (let p = Math.max(1, from); p <= Math.min(total, to); p++) shown.add(p);
  };
  addRange(1, EDGE);
  addRange(current - AROUND, current + AROUND);
  addRange(total - EDGE + 1, total);

  const links: (number | null)[] = [];
  let previous = 0;
  for (const p of [...shown].sort((a, b) => a - b)) {
    if (p - previous === 2) links.push(p - 1);
    else if (p - previous > 2) links.push(null);
    links.push(p);
    previous = p;
  }
  return links;
}

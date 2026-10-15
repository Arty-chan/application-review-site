import { db, transaction } from '../db/client.js';
import { visibilitySettings } from '../db/schema.js';
import {
  canView, companyAttributes, reviewReports, reviewsSetting, companyNotesSetting, importPageSetting,
  type Visibility, type Viewer, type VisibilitySettingDef,
} from '../config/company-attributes.js';

// Who can see what, as set by admins on the Admin page. A setting an admin has
// never saved uses its defaultVisibility from src/config/company-attributes.ts.
// Read fresh from the database on every call (it's a handful of rows), so a
// change applies to the very next request.

/** Every setting on the Admin page, in the groups it shows them in. */
export const visibilityGroups: { name: string; note?: string; settings: VisibilitySettingDef[] }[] = [
  {
    name: 'Reviews',
    settings: [reviewsSetting],
  },
  {
    name: 'Review reports',
    note: 'How many reviewers reported it, on companies and search results; the report on each review; and the Exclude filter.',
    settings: reviewReports,
  },
  {
    name: 'Companies',
    settings: [companyNotesSetting],
  },
  {
    name: 'Company attributes',
    note: 'The value on companies and search results, the search filter, and who can see and change it on the company form.',
    settings: companyAttributes,
  },
  {
    name: 'Pages',
    settings: [importPageSetting],
  },
];

const allSettings = visibilityGroups.flatMap((g) => g.settings);

/** Each setting's visibility right now, by key. */
export function currentVisibility(): Map<string, Visibility> {
  const saved = new Map(db.select().from(visibilitySettings).all().map((row) => [row.key, row.visibility]));
  return new Map(allSettings.map((s) => [s.key, saved.get(s.key) ?? s.defaultVisibility]));
}

/** Saves admins' choices, by setting key. */
export function saveVisibility(choices: Record<string, Visibility>): void {
  transaction((tx) => {
    for (const [key, visibility] of Object.entries(choices)) {
      tx.insert(visibilitySettings).values({ key, visibility })
        .onConflictDoUpdate({ target: visibilitySettings.key, set: { visibility } })
        .run();
    }
  });
}

/** One setting's visibility right now. */
export function visibilityOf(setting: VisibilitySettingDef): Visibility {
  return currentVisibility().get(setting.key)!;
}

/** Whether this viewer can see what one setting covers. */
export function canViewSetting(setting: VisibilitySettingDef, viewer: Viewer): boolean {
  return canView(visibilityOf(setting), viewer);
}

/** The settings in a list (e.g. the company attributes) this viewer can see. */
function visibleOf<T extends VisibilitySettingDef>(settings: T[], viewer: Viewer): T[] {
  const visibility = currentVisibility();
  return settings.filter((s) => canView(visibility.get(s.key)!, viewer));
}

export const visibleAttributes = (viewer: Viewer) => visibleOf(companyAttributes, viewer);
export const visibleReviewReports = (viewer: Viewer) => visibleOf(reviewReports, viewer);

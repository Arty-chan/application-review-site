import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  descendantCountryCodes, groupCountriesByRegion, summarizeCountryGroups, type RegionTreeNode,
} from '../../src/lib/regions.js';

// A small tree nested three levels deep, built without touching the database —
// descendantCountryCodes is a pure tree operation.
const centralAmerica: RegionTreeNode = { id: 4, name: 'Central America', countries: [{ code: 'MX', name: 'Mexico' }], children: [] };
const southAmerica: RegionTreeNode = { id: 5, name: 'South America', countries: [{ code: 'BR', name: 'Brazil' }], children: [] };
const latam: RegionTreeNode = { id: 3, name: 'LATAM', countries: [], children: [centralAmerica, southAmerica] };
const northAmerica: RegionTreeNode = {
  id: 2, name: 'North America', countries: [{ code: 'US', name: 'United States' }, { code: 'CA', name: 'Canada' }], children: [],
};
const amer: RegionTreeNode = { id: 1, name: 'AMER', countries: [], children: [northAmerica, latam] };
const emea: RegionTreeNode = {
  id: 6, name: 'EMEA', countries: [], children: [{ id: 7, name: 'Europe', countries: [{ code: 'DE', name: 'Germany' }], children: [] }],
};

describe('descendantCountryCodes', () => {
  test('a leaf node returns just its own countries', () => {
    assert.deepEqual(descendantCountryCodes(centralAmerica), ['MX']);
  });

  test('an intermediate node collects countries from all its children', () => {
    assert.deepEqual(descendantCountryCodes(latam).sort(), ['BR', 'MX']);
  });

  test('a top-level node collects countries across multiple levels of nesting', () => {
    assert.deepEqual(descendantCountryCodes(amer).sort(), ['BR', 'CA', 'MX', 'US']);
  });

  test("selecting one branch does not pull in a sibling branch's countries", () => {
    assert.ok(!descendantCountryCodes(emea).includes('US'), 'EMEA should not include AMER countries');
  });
});

describe('groupCountriesByRegion', () => {
  const tree = [amer, emea];

  test('countries are grouped under their regions, and regions without any are left out', () => {
    assert.deepEqual(groupCountriesByRegion(tree, new Set(['US', 'BR'])), [{
      name: 'AMER',
      whole: false,
      countries: [],
      children: [
        { name: 'North America', whole: false, countries: ['United States'], children: [] },
        { name: 'LATAM', whole: false, countries: [], children: [{ name: 'South America', whole: true, countries: ['Brazil'], children: [] }] },
      ],
    }]);
  });

  test('a whole region still lists its countries, and is marked once — not again on its sub-regions', () => {
    const [group] = groupCountriesByRegion(tree, new Set(['US', 'CA', 'MX', 'BR']));
    assert.equal(group.whole, true);
    assert.deepEqual(group.children.map((c) => [c.name, c.whole, c.countries]), [
      ['North America', false, ['United States', 'Canada']],
      ['LATAM', false, []],
    ]);
  });
});

describe('summarizeCountryGroups', () => {
  test('shows each whole region once, and the closest region of every other country', () => {
    const groups = groupCountriesByRegion([amer, emea], new Set(['US', 'CA', 'BR', 'DE']));
    assert.deepEqual(summarizeCountryGroups(groups), [
      { region: 'North America', whole: true, countries: ['United States', 'Canada'] },
      { region: 'South America', whole: true, countries: ['Brazil'] },
      { region: 'EMEA', whole: true, countries: ['Germany'] },
    ]);
  });

  test('a partly covered region lists just the included countries', () => {
    const groups = groupCountriesByRegion([amer], new Set(['US', 'MX']));
    assert.deepEqual(summarizeCountryGroups(groups), [
      { region: 'North America', whole: false, countries: ['United States'] },
      { region: 'Central America', whole: true, countries: ['Mexico'] },
    ]);
  });
});

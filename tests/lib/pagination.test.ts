import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pageLinks } from '../../src/lib/pagination.js';

describe('pageLinks', () => {
  test('a few pages are all shown', () => {
    assert.deepEqual(pageLinks(1, 1), [1]);
    assert.deepEqual(pageLinks(3, 5), [1, 2, 3, 4, 5]);
  });

  test('many pages show both ends and either side of the current one, with gaps between', () => {
    assert.deepEqual(pageLinks(10, 50), [1, 2, null, 9, 10, 11, null, 49, 50]);
    assert.deepEqual(pageLinks(1, 50), [1, 2, null, 49, 50]);
    assert.deepEqual(pageLinks(50, 50), [1, 2, null, 49, 50]);
  });

  test('a gap of just one page shows that page instead', () => {
    assert.deepEqual(pageLinks(5, 50), [1, 2, 3, 4, 5, 6, null, 49, 50]);
  });
});

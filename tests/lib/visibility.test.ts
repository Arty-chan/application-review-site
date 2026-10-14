import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations } from '../helpers/db.js';
import { companyAttributes } from '../../src/config/company-attributes.js';
import {
  currentVisibility, saveVisibility, visibleAttributes, canViewReviews,
} from '../../src/lib/visibility.js';

const anonymous = undefined;
const user = { role: 'user' as const };
const admin = { role: 'admin' as const };

before(async () => {
  await applyMigrations();
});

describe('visibility settings', () => {
  test('until an admin saves them, each setting uses its default', () => {
    const visibility = currentVisibility();
    for (const attr of companyAttributes) assert.equal(visibility.get(attr.key), attr.defaultVisibility);
  });

  test("an admin's choice replaces the default, and can be changed again", () => {
    saveVisibility({ hiresRemote: 'user', reviews: 'admin' });
    assert.ok(!visibleAttributes(anonymous).some((a) => a.key === 'hiresRemote'));
    assert.ok(visibleAttributes(user).some((a) => a.key === 'hiresRemote'));
    assert.deepEqual([anonymous, user, admin].map(canViewReviews), [false, false, true]);

    saveVisibility({ hiresRemote: 'public', reviews: 'public' });
    assert.ok(visibleAttributes(anonymous).some((a) => a.key === 'hiresRemote'));
    assert.ok(canViewReviews(anonymous));
  });
});

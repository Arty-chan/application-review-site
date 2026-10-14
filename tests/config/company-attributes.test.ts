import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canView, companyAttributes, visibleAttributes, reviewReports,
} from '../../src/config/company-attributes.js';

const anonymous = undefined;
const user = { role: 'user' as const };
const admin = { role: 'admin' as const };

describe('canView', () => {
  test('each visibility level admits the right viewers', () => {
    assert.deepEqual([anonymous, user, admin].map((v) => canView('public', v)), [true, true, true]);
    assert.deepEqual([anonymous, user, admin].map((v) => canView('user', v)), [false, true, true]);
    assert.deepEqual([anonymous, user, admin].map((v) => canView('admin', v)), [false, false, true]);
  });
});

describe('visibleAttributes', () => {
  test('every attribute is currently public, so anonymous and signed-in see the same set', () => {
    assert.deepEqual(visibleAttributes(anonymous).map((a) => a.key), visibleAttributes(user).map((a) => a.key));
  });

  test('anonymous visitors never see a user-only attribute, even if one is added later', () => {
    // Temporarily register a signed-in-only attribute in the real registry, so
    // this exercises visibleAttributes() itself rather than a copy of its logic.
    companyAttributes.push({
      key: 'hiresRemote', // reusing a real key for type simplicity
      label: 'Secret attribute',
      visibility: 'user',
      filter: 'require',
    });
    try {
      assert.ok(!visibleAttributes(anonymous).some((a) => a.label === 'Secret attribute'));
      assert.ok(visibleAttributes(user).some((a) => a.label === 'Secret attribute'));
    } finally {
      companyAttributes.pop();
    }
  });
});

describe('registry keys match the schema', () => {
  test('every company attribute key is a real column on the companies table', async () => {
    const { companies } = await import('../../src/db/schema.js');
    for (const attr of companyAttributes) {
      assert.ok(attr.key in companies, `${attr.key} should be a real column on companies`);
    }
  });

  test('every review report key is a real column on the reviews table', async () => {
    const { reviews } = await import('../../src/db/schema.js');
    for (const report of reviewReports) {
      assert.ok(report.key in reviews, `${report.key} should be a real column on reviews`);
    }
  });
});

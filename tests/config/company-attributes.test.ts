import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canView, companyAttributes, reviewReports, reviewsSetting,
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

describe('registry keys', () => {
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

  test('every visibility setting has its own key, since that is how its choice is saved', () => {
    const keys = [...companyAttributes, ...reviewReports, reviewsSetting].map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

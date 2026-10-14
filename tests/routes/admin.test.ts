import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/db/client.js';
import { companies, reviews } from '../../src/db/schema.js';
import { currentVisibility } from '../../src/lib/visibility.js';
import { startServer, TestClient, createUser, TEST_PASSWORD } from '../helpers/http.js';

let baseUrl: string;
let close: () => Promise<void>;
let admin: TestClient;

before(async () => {
  ({ baseUrl, close } = await startServer());
  const adminUser = await createUser({ role: 'admin' });
  admin = new TestClient(baseUrl);
  await admin.login(adminUser.email, TEST_PASSWORD);
});

after(async () => {
  await close();
});

/** The settings form as submitted: every setting at its current value, with some changed. */
function settingsForm(changes: Record<string, string>) {
  return { ...Object.fromEntries(currentVisibility()), ...changes };
}

describe('the Admin page', () => {
  test('has a section for each admin tool', async () => {
    const page = await admin.get('/admin');
    assert.equal(page.status, 200);
    for (const id of ['flags', 'add-user', 'settings', 'import']) {
      assert.ok(page.text.includes(`id="${id}"`), `should have the ${id} section`);
    }
  });

  test("a section's own URL (an old page, or where its form posts) leads to that section", async () => {
    assert.equal((await admin.get('/admin/flags')).location, '/admin#flags');
    assert.equal((await admin.get('/admin/settings')).location, '/admin#settings');
  });
});

describe('visibility settings', () => {
  test('saving them changes who can see what, straight away', async () => {
    const [company] = await db.insert(companies).values({
      name: 'Settings Co', websiteUrl: 'https://settings.example', websiteDomain: 'settings.example', updatedAt: new Date(),
    }).returning();
    const author = await createUser();
    await db.insert(reviews).values({
      companyId: company.id, userId: author.id, rating: 8, comment: 'A review to hide', jobProcessDate: new Date(), createdAt: new Date(),
    });
    const anonymous = new TestClient(baseUrl);
    assert.match((await anonymous.get(`/companies/${company.id}`)).text, /A review to hide/);

    const res = await admin.post('/admin/settings', settingsForm({ reviews: 'user' }));
    assert.equal(res.status, 200);
    assert.match(res.text, /Settings saved\./);
    assert.doesNotMatch((await anonymous.get(`/companies/${company.id}`)).text, /A review to hide/);

    await admin.post('/admin/settings', settingsForm({ reviews: 'public' }));
    assert.match((await anonymous.get(`/companies/${company.id}`)).text, /A review to hide/);
  });

  test('a form with an unknown choice is rejected, and nothing changes', async () => {
    const res = await admin.post('/admin/settings', settingsForm({ reviews: 'everyone' }));
    assert.equal(res.status, 400);
    assert.equal(currentVisibility().get('reviews'), 'public');
  });
});

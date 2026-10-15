import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { companies, reviews } from '../../src/db/schema.js';
import { currentVisibility } from '../../src/lib/visibility.js';
import { startServer, TestClient, createUser, TEST_PASSWORD } from '../helpers/http.js';

let baseUrl: string;
let close: () => Promise<void>;
let admin: TestClient;
let member: TestClient;

before(async () => {
  ({ baseUrl, close } = await startServer());
  const adminUser = await createUser({ role: 'admin' });
  admin = new TestClient(baseUrl);
  await admin.login(adminUser.email, TEST_PASSWORD);
  const memberUser = await createUser();
  member = new TestClient(baseUrl);
  await member.login(memberUser.email, TEST_PASSWORD);
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
    for (const id of ['flags', 'add-user', 'settings']) {
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

describe('company notes', () => {
  async function companyWithNotes(name: string) {
    const domain = `${name.toLowerCase().replace(/\W+/g, '-')}.example`;
    const [company] = await db.insert(companies).values({
      name, websiteUrl: `https://${domain}`, websiteDomain: domain, generalNotes: 'An internal note', updatedAt: new Date(),
    }).returning();
    return company;
  }

  test('who can read them follows the setting', async () => {
    const company = await companyWithNotes('Notes Co');
    const anonymous = new TestClient(baseUrl);
    assert.doesNotMatch((await anonymous.get(`/companies/${company.id}`)).text, /An internal note/, 'signed-in only by default');
    assert.match((await member.get(`/companies/${company.id}`)).text, /An internal note/);

    await admin.post('/admin/settings', settingsForm({ generalNotes: 'public' }));
    assert.match((await anonymous.get(`/companies/${company.id}`)).text, /An internal note/);
    await admin.post('/admin/settings', settingsForm({ generalNotes: 'user' }));
  });

  test("editing a company without being able to see its notes leaves them as they are", async () => {
    const company = await companyWithNotes('Hidden Notes Co');
    await admin.post('/admin/settings', settingsForm({ generalNotes: 'admin' }));
    try {
      assert.doesNotMatch((await member.get(`/companies/${company.id}/edit`)).text, /name="generalNotes"/);
      const res = await member.post(`/companies/${company.id}`, { name: 'Hidden Notes Co, renamed', websiteUrl: company.websiteUrl });
      assert.equal(res.location, `/companies/${company.id}`);
      const saved = await db.query.companies.findFirst({ where: eq(companies.id, company.id) });
      assert.equal(saved?.name, 'Hidden Notes Co, renamed');
      assert.equal(saved?.generalNotes, 'An internal note');
    } finally {
      await admin.post('/admin/settings', settingsForm({ generalNotes: 'user' }));
    }
  });
});

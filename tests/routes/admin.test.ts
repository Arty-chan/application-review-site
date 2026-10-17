import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { companies, reviews, industries, companyIndustries } from '../../src/db/schema.js';
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
    for (const id of ['flags', 'add-user', 'settings', 'industries']) {
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

describe('industries', () => {
  let counter = 0;
  async function companyIn(...industryIds: number[]) {
    counter += 1;
    const [company] = await db.insert(companies).values({
      name: `Industry Co ${counter}`, websiteUrl: `https://industry-${counter}.example`, websiteDomain: `industry-${counter}.example`, updatedAt: new Date(),
    }).returning();
    if (industryIds.length) await db.insert(companyIndustries).values(industryIds.map((industryId) => ({ companyId: company.id, industryId })));
    return company;
  }
  const industriesOf = async (companyId: number) =>
    (await db.select().from(companyIndustries).where(eq(companyIndustries.companyId, companyId))).map((l) => l.industryId);

  test('the Admin page lists each industry with how many companies use it', async () => {
    const [mining] = await db.insert(industries).values({ name: 'Mining' }).returning();
    await companyIn(mining.id);
    await companyIn(mining.id);
    assert.match((await admin.get('/admin')).text, /value="Mining"[\s\S]*?<td>2<\/td>/);
  });

  test("renaming works, but not to another industry's name in different capitals", async () => {
    const [typo] = await db.insert(industries).values({ name: 'Agricultre' }).returning();
    await db.insert(industries).values({ name: 'Forestry' });
    await admin.post('/admin/industries', { action: 'rename', id: String(typo.id), name: 'Agriculture' });
    assert.equal((await db.query.industries.findFirst({ where: eq(industries.id, typo.id) }))?.name, 'Agriculture');

    const res = await admin.post('/admin/industries', { action: 'rename', id: String(typo.id), name: 'FORESTRY' });
    assert.equal(res.status, 400);
    assert.match(res.text, /already exists/);
  });

  test("merging moves the industry's companies to the other one, and removes it", async () => {
    const [fintech] = await db.insert(industries).values({ name: 'Fintech' }).returning();
    const [finance] = await db.insert(industries).values({ name: 'Finance Co' }).returning();
    const onlyFintech = await companyIn(fintech.id);
    const both = await companyIn(fintech.id, finance.id);

    await admin.post('/admin/industries', { action: 'merge', id: String(fintech.id), into: String(finance.id) });
    assert.deepEqual(await industriesOf(onlyFintech.id), [finance.id]);
    assert.deepEqual(await industriesOf(both.id), [finance.id], 'listed once, not twice');
    assert.equal(await db.query.industries.findFirst({ where: eq(industries.id, fintech.id) }), undefined);
  });

  test('only an industry no company uses can be deleted', async () => {
    const [unused] = await db.insert(industries).values({ name: 'Unused' }).returning();
    const [used] = await db.insert(industries).values({ name: 'Used' }).returning();
    await companyIn(used.id);

    await admin.post('/admin/industries', { action: 'delete', id: String(unused.id) });
    assert.equal(await db.query.industries.findFirst({ where: eq(industries.id, unused.id) }), undefined);

    const res = await admin.post('/admin/industries', { action: 'delete', id: String(used.id) });
    assert.equal(res.status, 400);
    assert.ok(await db.query.industries.findFirst({ where: eq(industries.id, used.id) }));
  });

  test('regular users cannot change industries', async () => {
    const [kept] = await db.insert(industries).values({ name: 'Kept' }).returning();
    assert.equal((await member.post('/admin/industries', { action: 'delete', id: String(kept.id) })).status, 403);
    assert.ok(await db.query.industries.findFirst({ where: eq(industries.id, kept.id) }));
  });
});

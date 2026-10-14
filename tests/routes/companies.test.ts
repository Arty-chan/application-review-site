import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { companies, industries, reviews } from '../../src/db/schema.js';
import {
  startServer, TestClient, createUser, seedReferenceData, companyIdFrom, resultNames, TEST_PASSWORD,
} from '../helpers/http.js';
import { reviewsConfig } from '../../src/config/company-attributes.js';
import { SITE_NAME } from '../../src/config/site.js';

let baseUrl: string;
let close: () => Promise<void>;
let ref: Awaited<ReturnType<typeof seedReferenceData>>;

before(async () => {
  ({ baseUrl, close } = await startServer());
  ref = await seedReferenceData();
});

after(async () => {
  await close();
});

async function signedIn(role: 'user' | 'admin' = 'user') {
  const user = await createUser({ role });
  const client = new TestClient(baseUrl);
  await client.login(user.email, TEST_PASSWORD);
  return client;
}

describe('adding and editing companies', () => {
  test('a signed-in user can add a company', async () => {
    const client = await signedIn();
    const res = await client.post('/companies', {
      name: 'Acme',
      websiteUrl: 'acme.com',
      employeeSizeRange: '11-50',
      countries: ['DE', 'FR'],
      industries: String(ref.software.id),
      hiresRemote: 'true',
    });
    const id = companyIdFrom(res);

    const detail = await client.get(`/companies/${id}`);
    assert.equal(detail.status, 200);
    for (const text of ['Acme', 'Germany', 'France', 'Software', '11-50 employees', 'Hires remote: Yes']) {
      assert.ok(detail.text.includes(text), `detail page should show "${text}"`);
    }
    // Germany and France are the test data's whole EMEA region, so it's marked as such.
    assert.match(detail.text, /<strong>EMEA<\/strong> <span class="note">\(all\)<\/span>: France, Germany/);

    const stored = await db.query.companies.findFirst({ where: eq(companies.id, id) });
    assert.equal(stored?.websiteUrl, 'https://acme.com');
    assert.equal(stored?.websiteDomain, 'acme.com');
  });

  test('a second company on the same website domain is rejected', async () => {
    const client = await signedIn();
    companyIdFrom(await client.post('/companies', { name: 'Globex', websiteUrl: 'globex.com' }));

    const dup = await client.post('/companies', { name: 'Globex Again', websiteUrl: 'https://www.globex.com' });
    assert.equal(dup.status, 400);
    assert.match(dup.text, /already exists/);
  });

  test('a company can be edited', async () => {
    const client = await signedIn();
    const id = companyIdFrom(await client.post('/companies', { name: 'Initech', websiteUrl: 'initech.com', countries: 'US' }));

    const form = await client.get(`/companies/${id}/edit`);
    assert.equal(form.status, 200);
    assert.match(form.text, /Edit company/);

    const res = await client.post(`/companies/${id}`, { name: 'Initech Corp', websiteUrl: 'initech.com', countries: 'DE' });
    assert.equal(res.location, `/companies/${id}`);

    const detail = await client.get(`/companies/${id}`);
    assert.match(detail.text, /Initech Corp/);
    assert.match(detail.text, /Germany/);
    assert.doesNotMatch(detail.text, /United States/);
  });

  test('a new industry can be added from the company form', async () => {
    const client = await signedIn();
    const id = companyIdFrom(await client.post('/companies', { name: 'Cyberdyne', websiteUrl: 'cyberdyne.com', newIndustry: 'Robotics' }));

    assert.match((await client.get(`/companies/${id}`)).text, /Robotics/);
    assert.ok(await db.query.industries.findFirst({ where: eq(industries.name, 'Robotics') }));
  });

  test('anonymous visitors cannot add companies', async () => {
    const res = await new TestClient(baseUrl).post('/companies', { name: 'Nope', websiteUrl: 'nope.com' });
    assert.equal(res.location, '/login');
    assert.equal(await db.query.companies.findFirst({ where: eq(companies.name, 'Nope') }), undefined);
  });
});

describe('browsing and searching', () => {
  before(async () => {
    const client = await signedIn();
    companyIdFrom(await client.post('/companies', {
      name: 'Umbrella Labs', websiteUrl: 'umbrella.com', countries: 'FR', industries: String(ref.finance.id), hiresRemote: 'true',
    }));
    companyIdFrom(await client.post('/companies', {
      name: 'Stark Industries', websiteUrl: 'stark.com', countries: 'US', hiresRemote: 'false', postsGhostJobs: 'false',
    }));
    companyIdFrom(await client.post('/companies', { name: 'Ghostly Corp', websiteUrl: 'ghostly.com', postsGhostJobs: 'true' }));
  });

  test('anonymous visitors can see the list and a company page', async () => {
    const client = new TestClient(baseUrl);
    const list = await client.get('/');
    assert.ok(resultNames(list.text).includes('Umbrella Labs'));

    const id = (await db.query.companies.findFirst({ where: eq(companies.name, 'Umbrella Labs') }))!.id;
    const detail = await client.get(`/companies/${id}`);
    assert.equal(detail.status, 200);
    assert.match(detail.text, /Umbrella Labs/);
    assert.ok(detail.text.includes(`<title>Umbrella Labs — ${SITE_NAME}</title>`), 'the configured site name is in the title');
    assert.ok(detail.text.includes(`<strong>${SITE_NAME}</strong>`), 'and in the nav bar');
  });

  test('searching by name', async () => {
    const names = resultNames((await new TestClient(baseUrl).get('/?q=umbr')).text);
    assert.deepEqual(names, ['Umbrella Labs']);
  });

  test('filtering by country', async () => {
    const names = resultNames((await new TestClient(baseUrl).get('/?country=US')).text);
    assert.ok(names.includes('Stark Industries'));
    assert.ok(!names.includes('Umbrella Labs'));
  });

  test('filtering by several countries matches any of them (what a region\'s "select all" submits)', async () => {
    const names = resultNames((await new TestClient(baseUrl).get('/?country=DE&country=FR')).text);
    assert.ok(names.includes('Umbrella Labs'), 'hires in France');
    assert.ok(!names.includes('Stark Industries'), 'hires only in the US');
  });

  test('filtering by industry', async () => {
    const names = resultNames((await new TestClient(baseUrl).get(`/?industry=${ref.finance.id}`)).text);
    assert.deepEqual(names, ['Umbrella Labs']);
  });

  test('filtering by a hiring-process attribute', async () => {
    const names = resultNames((await new TestClient(baseUrl).get('/?hiresRemote=true')).text);
    assert.ok(names.includes('Umbrella Labs'));
    assert.ok(!names.includes('Stark Industries'));
  });

  test('excluding companies that post ghost jobs', async () => {
    const names = resultNames((await new TestClient(baseUrl).get('/?exclude=postsGhostJobs')).text);
    assert.ok(!names.includes('Ghostly Corp'));
    assert.ok(names.includes('Stark Industries'), 'a definite No stays in');
    assert.ok(names.includes('Umbrella Labs'), 'Unknown stays in');
  });
});

describe('sorting', () => {
  // Names share "Sortable" so a search picks out just these. Rated 4.5, 2 and
  // none (A has a second rating, of 2, so the most ratings); updated in the
  // order C, A, B.
  before(async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    const inserted = await db.insert(companies).values([
      { name: 'Sortable B', websiteUrl: 'https://sortable-b.com', websiteDomain: 'sortable-b.com', updatedAt: day(3) },
      { name: 'sortable A', websiteUrl: 'https://sortable-a.com', websiteDomain: 'sortable-a.com', updatedAt: day(2) },
      { name: 'Sortable C', websiteUrl: 'https://sortable-c.com', websiteDomain: 'sortable-c.com', updatedAt: day(1) },
    ]).returning();
    const id = (name: string) => inserted.find((c) => c.name === name)!.id;
    const [reviewer, secondReviewer] = await Promise.all([createUser(), createUser()]);
    await db.insert(reviews).values([
      { companyId: id('sortable A'), userId: secondReviewer.id, rating: 4, comment: 'a2', jobProcessDate: day(1), createdAt: day(1) },
      { companyId: id('Sortable B'), userId: reviewer.id, rating: 9, comment: 'b', jobProcessDate: day(1), createdAt: day(1) },
      { companyId: id('sortable A'), userId: reviewer.id, rating: 4, comment: 'a', jobProcessDate: day(1), createdAt: day(1) },
      { companyId: id('Sortable C'), userId: reviewer.id, rating: null, comment: 'c', jobProcessDate: day(1), createdAt: day(1) },
    ]);
  });

  const sorted = async (client: TestClient, params: string) => resultNames((await client.get(`/?q=sortable&${params}`)).text);

  test('alphabetical, ignoring case, is the default', async () => {
    const anon = new TestClient(baseUrl);
    assert.deepEqual(await sorted(anon, ''), ['sortable A', 'Sortable B', 'Sortable C']);
    assert.deepEqual(await sorted(anon, 'order=desc'), ['Sortable C', 'Sortable B', 'sortable A']);
  });

  test('by updated date', async () => {
    const anon = new TestClient(baseUrl);
    assert.deepEqual(await sorted(anon, 'sort=updated&order=desc'), ['Sortable B', 'sortable A', 'Sortable C']);
  });

  test('by rating or number of ratings, for whoever can see reviews', async () => {
    const anon = new TestClient(baseUrl);
    assert.deepEqual(await sorted(anon, 'sort=rating&order=desc'), ['Sortable B', 'sortable A', 'Sortable C']);
    assert.deepEqual(await sorted(anon, 'sort=rating&order=asc'), ['sortable A', 'Sortable B', 'Sortable C']);
    assert.deepEqual(await sorted(anon, 'sort=ratingCount&order=desc'), ['sortable A', 'Sortable B', 'Sortable C']);

    reviewsConfig.visibility = 'user';
    try {
      for (const sort of ['rating', 'ratingCount']) {
        assert.deepEqual(await sorted(anon, `sort=${sort}&order=desc`), ['Sortable C', 'Sortable B', 'sortable A'],
          'with reviews signed-in only, a signed-out visitor falls back to alphabetical');
      }
      const client = await signedIn();
      assert.deepEqual(await sorted(client, 'sort=rating&order=desc'), ['Sortable B', 'sortable A', 'Sortable C']);
    } finally {
      reviewsConfig.visibility = 'public';
    }
  });
});

describe('deleting companies', () => {
  test('an admin can delete a company', async () => {
    const admin = await signedIn('admin');
    const id = companyIdFrom(await admin.post('/companies', { name: 'Doomed Co', websiteUrl: 'doomed.com' }));

    const res = await admin.post(`/companies/${id}/delete`);
    assert.equal(res.status, 302);
    assert.equal((await admin.get(`/companies/${id}`)).status, 404);
  });

  test('a regular user cannot delete a company', async () => {
    const client = await signedIn();
    const id = companyIdFrom(await client.post('/companies', { name: 'Sturdy Co', websiteUrl: 'sturdy.com' }));

    const res = await client.post(`/companies/${id}/delete`);
    assert.equal(res.status, 403);
    assert.equal((await client.get(`/companies/${id}`)).status, 200);
  });
});

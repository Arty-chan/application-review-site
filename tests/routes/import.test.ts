import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { companies, companyCountries, companyIndustries, industries } from '../../src/db/schema.js';
import { startServer, TestClient, createUser, seedReferenceData, TEST_PASSWORD } from '../helpers/http.js';
import { saveVisibility } from '../../src/lib/visibility.js';

let baseUrl: string;
let close: () => Promise<void>;
let admin: TestClient;
let member: TestClient;

before(async () => {
  ({ baseUrl, close } = await startServer());
  await seedReferenceData(); // EMEA (DE, FR), AMER (US); industries Software, Finance
  [admin, member] = await Promise.all([signIn('admin'), signIn('user')]);
});

after(async () => {
  await close();
});

async function signIn(role: 'user' | 'admin') {
  const user = await createUser({ role });
  const client = new TestClient(baseUrl);
  await client.login(user.email, TEST_PASSWORD);
  return client;
}

async function findCompany(name: string) {
  const company = await db.query.companies.findFirst({ where: eq(companies.name, name) });
  if (!company) return undefined;
  const countries = await db.select().from(companyCountries).where(eq(companyCountries.companyId, company.id));
  const [link] = await db.select({ name: industries.name }).from(companyIndustries)
    .innerJoin(industries, eq(companyIndustries.industryId, industries.id))
    .where(eq(companyIndustries.companyId, company.id));
  return { ...company, countryCodes: countries.map((c) => c.countryCode).sort(), industry: link?.name };
}

describe('importing companies from CSV', () => {
  test('admins are shown the columns to use before pasting', async () => {
    const page = await admin.get('/import');
    assert.equal(page.status, 200);
    for (const column of ['name', 'websiteUrl', 'location', 'industry', 'postsGhostJobs']) {
      assert.ok(page.text.includes(`<code>${column}</code>`), `should list the ${column} column`);
    }
  });

  test('only admins can import, by default', async () => {
    assert.equal((await member.get('/import')).status, 403);
    assert.equal((await member.post('/import', { csv: 'name,websiteUrl\nSneaky,sneaky.com' })).status, 403);
    assert.doesNotMatch((await member.get('/')).text, /href="\/import"/, 'no Import link in the nav');
  });

  test('an admin setting opens it to every signed-in member', async () => {
    saveVisibility({ importPage: 'user' });
    try {
      const page = await member.get('/import');
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.text, /Export companies/, 'exporting stays admins only');
      assert.match((await member.get('/')).text, /href="\/import"/, 'the nav links to it');
      assert.equal((await new TestClient(baseUrl).get('/import')).location, '/login');
    } finally {
      saveVisibility({ importPage: 'admin' });
    }
  });

  test('each row is added, or listed with the reason it failed', async () => {
    const csv = [
      'name,websiteUrl,location,industry,hiresRemote,postsGhostJobs',
      'Acme,acme.com,DE,software,yes,no',
      '"Globex, Inc.",globex.com,emea,Robotics,,',
      'Umbrella,umbrella.com,,,,',
      'Initech,initech.com,Atlantis,,,',
    ].join('\n');
    const res = await admin.post('/import', { csv });
    assert.equal(res.status, 200);
    assert.match(res.text, /Added 3 of 4\./);

    const acme = await findCompany('Acme');
    assert.ok(res.text.includes(`<a href="/companies/${acme?.id}">Acme</a>`), 'an added company links to its page');
    assert.deepEqual(acme?.countryCodes, ['DE'], 'a country');
    assert.equal(acme?.industry, 'Software', 'matched to the existing industry regardless of case');
    assert.equal(acme?.hiresRemote, true);
    assert.equal(acme?.postsGhostJobs, false);

    const globex = await findCompany('Globex, Inc.');
    assert.deepEqual(globex?.countryCodes, ['DE', 'FR'], 'a region means every country in it');
    assert.equal(globex?.industry, 'Robotics', 'an industry not listed yet is added');

    const umbrella = await findCompany('Umbrella');
    assert.deepEqual(umbrella?.countryCodes, ['DE', 'FR', 'US'], 'no location means anywhere');
    assert.equal(umbrella?.hiresRemote, null, 'a blank attribute is unknown');

    assert.equal(await findCompany('Initech'), undefined);
    assert.match(res.text, /Initech — <span class="error">Unknown location &quot;Atlantis&quot;\.<\/span>/);
  });

  test('a header row with an unknown column is rejected before anything is imported', async () => {
    const res = await admin.post('/import', { csv: 'name,website\nHooli,hooli.com' });
    assert.equal(res.status, 400);
    assert.match(res.text, /recognized: website/);
    assert.equal(await findCompany('Hooli'), undefined);
  });
});

describe('exporting companies as CSV', () => {
  test('admins download every company, in the import columns', async () => {
    await admin.post('/import', {
      csv: 'name,websiteUrl,location,listsSalary,generalNotes\n"Export, Inc.",export.com,US,yes,"A ""quoted"" word"',
    });
    const res = await admin.get('/import/export.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="companies.csv"/);

    const [header, ...rows] = res.text.replace(/^\uFEFF/, '').trim().split('\n');
    assert.ok(header.startsWith('name,websiteUrl,careersUrl,employeeSizeRange,location,industry,generalNotes,'));
    const row = rows.find((r) => r.startsWith('"Export, Inc."'));
    assert.ok(row, 'a name with a comma is quoted');
    assert.ok(row.startsWith('"Export, Inc.",https://export.com,,,US,,"A ""quoted"" word",'), 'quotes inside a value are doubled');
  });

  test('members cannot export, even when they can import', async () => {
    saveVisibility({ importPage: 'user' });
    try {
      assert.equal((await member.get('/import/export.csv')).status, 403);
    } finally {
      saveVisibility({ importPage: 'admin' });
    }
  });
});

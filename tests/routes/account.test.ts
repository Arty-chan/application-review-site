import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { users, companies, reviews } from '../../src/db/schema.js';
import { createToken } from '../../src/lib/tokens.js';
import { startServer, TestClient, createUser, TEST_PASSWORD } from '../helpers/http.js';
import { PASSWORD_MIN_LENGTH, DISPLAY_NAME_MAX_LENGTH } from '../../src/config/site.js';

let baseUrl: string;
let close: () => Promise<void>;

// The file's only admin — tests that promote someone else demote them again,
// so "last remaining admin" always refers to this account.
let adminUser: Awaited<ReturnType<typeof createUser>>;
let admin: TestClient;
// A regular signed-in user for tests that don't change login details. Shared so
// the file stays well under the login rate limit (10 attempts per window).
let memberUser: Awaited<ReturnType<typeof createUser>>;
let member: TestClient;

before(async () => {
  ({ baseUrl, close } = await startServer());
  ({ user: adminUser, client: admin } = await signedIn('admin'));
  ({ user: memberUser, client: member } = await signedIn());
});

after(async () => {
  await close();
});

async function signedIn(role: 'user' | 'admin' = 'user') {
  const user = await createUser({ role });
  const client = new TestClient(baseUrl);
  await client.login(user.email, TEST_PASSWORD);
  return { user, client };
}

let companyCounter = 0;
async function makeCompany() {
  companyCounter += 1;
  const [company] = await db.insert(companies).values({
    name: `Account Test Co ${companyCounter}`,
    websiteUrl: `https://accountco${companyCounter}.com`,
    websiteDomain: `accountco${companyCounter}.com`,
    updatedAt: new Date(),
  }).returning();
  return company;
}

describe('favorites', () => {
  test('favoriting and unfavoriting a company', async () => {
    const company = await makeCompany();

    assert.match((await member.get(`/companies/${company.id}`)).text, /☆ Favorite/);

    await member.post(`/companies/${company.id}/favorite`);
    assert.ok((await member.get('/account/favorites')).text.includes(company.name));
    assert.match((await member.get(`/companies/${company.id}`)).text, /★ Unfavorite/, 'the button toggles');

    await member.post(`/companies/${company.id}/favorite/delete`);
    assert.ok(!(await member.get('/account/favorites')).text.includes(company.name));
    assert.match((await member.get(`/companies/${company.id}`)).text, /☆ Favorite/);
  });
});

describe('account settings', () => {
  test('/account goes to your own account page', async () => {
    assert.equal((await member.get('/account')).location, `/users/${memberUser.id}`);
    const page = await member.get(`/users/${memberUser.id}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`Display name (up to ${DISPLAY_NAME_MAX_LENGTH} characters)`), 'the limits come from the site settings');
    assert.ok(page.text.includes(`New password (at least ${PASSWORD_MIN_LENGTH} characters)`));
  });

  test('changing your display name', async () => {
    const res = await member.post(`/users/${memberUser.id}`, { displayName: 'Renamed Rita' });
    assert.equal(res.location, `/users/${memberUser.id}`);
    assert.match((await member.get('/')).text, /Renamed Rita/);
  });

  test('changing your password requires your current one, and signs out your other sessions', async () => {
    const { user, client } = await signedIn();
    const otherDevice = new TestClient(baseUrl);
    await otherDevice.login(user.email, TEST_PASSWORD);

    const wrong = await client.post(`/users/${user.id}/password`, { currentPassword: 'not-it', newPassword: 'another-password' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /Current password is incorrect/);

    const right = await client.post(`/users/${user.id}/password`, { currentPassword: TEST_PASSWORD, newPassword: 'another-password' });
    assert.equal(right.status, 200);
    assert.match(right.text, /Password updated/);
    assert.equal((await client.get('/account')).location, `/users/${user.id}`, 'this browser stays signed in');
    assert.equal((await otherDevice.get('/account')).location, '/login', 'other sessions are signed out');
    await new TestClient(baseUrl).login(user.email, 'another-password');
  });

  test('changing your email needs your current password, and takes effect once the new address is verified', async () => {
    const { user, client } = await signedIn();

    const wrong = await client.post(`/users/${user.id}/email`, { email: 'verified-new@example.test', currentPassword: 'not-it' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /Current password is incorrect/);

    const res = await client.post(`/users/${user.id}/email`, { email: 'verified-new@example.test', currentPassword: TEST_PASSWORD });
    assert.equal(res.status, 200);
    let stored = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    assert.equal(stored?.email, user.email, 'the email does not change until verified');
    assert.equal(stored?.pendingEmail, 'verified-new@example.test');

    // The route emails the raw token; only its hash is stored, so mint one directly.
    const token = createToken(user.id, 'email_verify');
    const verify = await client.get(`/verify-email/${token}`);
    assert.match(verify.text, /Email verified/);
    stored = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    assert.equal(stored?.email, 'verified-new@example.test');
    assert.equal(stored?.pendingEmail, null);
  });

  test("users cannot open someone else's account page, but admins can", async () => {
    const someoneElse = await createUser();

    assert.equal((await member.get(`/users/${someoneElse.id}`)).status, 403);
    assert.equal((await admin.get(`/users/${someoneElse.id}`)).status, 200);
  });
});

describe('roles', () => {
  test('an admin can promote a user to admin and back', async () => {
    const target = await createUser();

    await admin.post(`/users/${target.id}/role`, { role: 'admin' });
    assert.equal((await db.query.users.findFirst({ where: eq(users.id, target.id) }))?.role, 'admin');

    await admin.post(`/users/${target.id}/role`, { role: 'user' });
    assert.equal((await db.query.users.findFirst({ where: eq(users.id, target.id) }))?.role, 'user');
  });

  test('the last remaining admin cannot be demoted', async () => {
    const res = await admin.post(`/users/${adminUser.id}/role`, { role: 'user' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Cannot remove the last remaining admin/);
  });

  test('admins can turn flagged-review emails off and back on', async () => {
    assert.match((await admin.get(`/users/${adminUser.id}`)).text, /Email when a review is flagged/);
    assert.doesNotMatch((await member.get(`/users/${memberUser.id}`)).text, /Email when a review is flagged/,
      'regular users never get these emails, so they have no setting');

    await admin.post(`/users/${adminUser.id}/notifications`); // box unticked
    assert.equal((await db.query.users.findFirst({ where: eq(users.id, adminUser.id) }))?.notifyOnFlags, false);
    await admin.post(`/users/${adminUser.id}/notifications`, { notifyOnFlags: 'true' });
    assert.equal((await db.query.users.findFirst({ where: eq(users.id, adminUser.id) }))?.notifyOnFlags, true);
  });

  test('regular users cannot change roles', async () => {
    assert.equal((await member.post(`/users/${memberUser.id}/role`, { role: 'admin' })).status, 403);
    assert.equal((await db.query.users.findFirst({ where: eq(users.id, memberUser.id) }))?.role, 'user');
  });
});

describe('adding users', () => {
  test('an admin can add a user with a password and role, who can then log in', async () => {
    const res = await admin.post('/admin/users/new', {
      email: 'added@example.test', displayName: 'Added User', password: 'added-password', role: 'admin',
    });
    const added = await db.query.users.findFirst({ where: eq(users.email, 'added@example.test') });
    assert.ok(added);
    assert.equal(res.location, `/users/${added.id}`);
    assert.equal(added.role, 'admin');
    assert.equal(added.displayName, 'Added User');

    const client = new TestClient(baseUrl);
    await client.login('added@example.test', 'added-password');
    assert.equal((await client.get('/admin')).status, 200, 'signed in, with the chosen role');
    await db.update(users).set({ role: 'user' }).where(eq(users.id, added.id)); // keep adminUser the only admin
  });

  test('regular users cannot add users', async () => {
    assert.equal((await member.get('/admin')).status, 403);
    const res = await member.post('/admin/users/new', {
      email: 'sneaky@example.test', displayName: 'Sneaky', password: 'sneaky-password', role: 'admin',
    });
    assert.equal(res.status, 403);
    assert.equal(await db.query.users.findFirst({ where: eq(users.email, 'sneaky@example.test') }), undefined);
  });
});

describe('deleting an account', () => {
  test("deleting your account signs you out and keeps your reviews under your name", async () => {
    const { user, client } = await signedIn();
    const company = await makeCompany();
    await client.post(`/companies/${company.id}/reviews`, { rating: '6', comment: 'Written before leaving' });

    const res = await client.post(`/users/${user.id}/delete`);
    assert.equal(res.location, '/');
    assert.equal(await db.query.users.findFirst({ where: eq(users.id, user.id) }), undefined);
    assert.equal((await client.get('/companies/new')).location, '/login', 'the session is gone');

    const review = await db.query.reviews.findFirst({ where: eq(reviews.companyId, company.id) });
    assert.equal(review?.userId, null);
    assert.equal(review?.deletedUserDisplayName, user.displayName);
  });
});

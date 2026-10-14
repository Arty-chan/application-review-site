import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { users, authTokens } from '../../src/db/schema.js';
import { createToken } from '../../src/lib/tokens.js';
import { startServer, TestClient, createUser, TEST_PASSWORD } from '../helpers/http.js';

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  ({ baseUrl, close } = await startServer());
});

after(async () => {
  await close();
});

describe('basic pages', () => {
  test('the health check responds', async () => {
    const res = await new TestClient(baseUrl).get('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true });
  });

  test('the company list is public', async () => {
    const res = await new TestClient(baseUrl).get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /Log in/);
  });

  test('static assets are served', async () => {
    const client = new TestClient(baseUrl);
    assert.equal((await client.get('/styles.css')).status, 200);
    assert.equal((await client.get('/app.js')).status, 200);
  });

  test('an unknown URL is a 404', async () => {
    const res = await new TestClient(baseUrl).get('/no-such-page');
    assert.equal(res.status, 404);
  });
});

describe('login and logout', () => {
  test('correct credentials sign you in', async () => {
    const user = await createUser({ displayName: 'Logged In Larry' });
    const client = new TestClient(baseUrl);
    await client.login(user.email, TEST_PASSWORD);

    const home = await client.get('/');
    assert.match(home.text, /Log out/);
    assert.match(home.text, /Logged In Larry/);
  });

  test('a wrong password is rejected', async () => {
    const user = await createUser();
    const res = await new TestClient(baseUrl).post('/login', { email: user.email, password: 'wrong-password' });
    assert.equal(res.status, 401);
    assert.match(res.text, /Incorrect email or password/);
  });

  test('logging out ends the session', async () => {
    const user = await createUser();
    const client = new TestClient(baseUrl);
    await client.login(user.email, TEST_PASSWORD);

    const res = await client.post('/logout');
    assert.equal(res.status, 302);
    assert.equal((await client.get('/companies/new')).location, '/login');
  });

  test('signed-in-only pages redirect anonymous visitors to the login page', async () => {
    const res = await new TestClient(baseUrl).get('/companies/new');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/login');
  });

  test('a form posted without its CSRF token is rejected', async () => {
    const user = await createUser();
    const res = await new TestClient(baseUrl).postWithoutCsrf('/login', { email: user.email, password: TEST_PASSWORD });
    assert.equal(res.status, 403);
  });
});

describe('password reset', () => {
  test('requesting a reset issues a reset token for that account', async () => {
    const user = await createUser();
    const res = await new TestClient(baseUrl).post('/forgot-password', { email: user.email });
    assert.equal(res.status, 200);
    assert.match(res.text, /If that email is registered/);

    const tokens = await db.select().from(authTokens)
      .where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, 'password_reset')));
    assert.equal(tokens.length, 1);
  });

  test('a reset link sets a new password and signs you in', async () => {
    const user = await createUser();
    // The route emails the raw token; only its hash is stored, so mint one directly.
    const token = createToken(user.id, 'password_reset');
    const client = new TestClient(baseUrl);

    const page = await client.get(`/reset-password/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Reset your password/);

    const res = await client.post(`/reset-password/${token}`, { password: 'brand-new-password' });
    assert.equal(res.status, 302);
    assert.match((await client.get('/')).text, /Log out/);

    const fresh = new TestClient(baseUrl);
    assert.equal((await fresh.post('/login', { email: user.email, password: TEST_PASSWORD })).status, 401);
    await fresh.login(user.email, 'brand-new-password');
  });
});

describe('invites', () => {
  test('a signed-in user can invite someone by email', async () => {
    const inviter = await createUser();
    const client = new TestClient(baseUrl);
    await client.login(inviter.email, TEST_PASSWORD);

    const res = await client.post('/invites', { email: 'newcomer@example.test' });
    assert.equal(res.status, 200);
    assert.match(res.text, /Invite sent to newcomer@example.test/);

    const invited = await db.query.users.findFirst({ where: eq(users.email, 'newcomer@example.test') });
    assert.ok(invited);
    assert.equal(invited.passwordHash, null, 'an invited account has no password until activated');
    assert.equal(invited.invitedBy, inviter.id);
  });

  test('accepting an invite sets a display name and password, then signs you in', async () => {
    const [invited] = await db.insert(users).values({ email: 'invitee@example.test', createdAt: new Date() }).returning();
    const token = createToken(invited.id, 'invite_setup');
    const client = new TestClient(baseUrl);

    const page = await client.get(`/reset-password/${token}`);
    assert.match(page.text, /Set up your account/);

    const res = await client.post(`/reset-password/${token}`, { displayName: 'New Person', password: 'new-person-password' });
    assert.equal(res.status, 302);
    assert.match((await client.get('/')).text, /New Person/);
  });
});

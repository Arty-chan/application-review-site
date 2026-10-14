import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { applyMigrations } from '../helpers/db.js';
import { db, transaction } from '../../src/db/client.js';
import { users, authTokens } from '../../src/db/schema.js';
import { createToken, lookupToken, lookupResetOrInviteToken, consumeToken, lifetimeText } from '../../src/lib/tokens.js';

before(async () => {
  await applyMigrations();
});

async function makeUser(email: string) {
  const [user] = await db.insert(users).values({ email, displayName: 'Test User', createdAt: new Date() }).returning();
  return user;
}

describe('token lifecycle', () => {
  test('a freshly created token is valid and resolves to the right user', async () => {
    const user = await makeUser('token-fresh@example.com');
    const raw = createToken(user.id, 'password_reset');
    const result = await lookupToken(raw, 'password_reset');
    assert.equal(result.valid, true);
    assert.equal(result.userId, user.id);
  });

  test('a token is only valid for the purpose it was created for', async () => {
    const user = await makeUser('token-purpose@example.com');
    const raw = createToken(user.id, 'password_reset');
    const result = await lookupToken(raw, 'invite_setup');
    assert.equal(result.valid, false);
  });

  test('a nonexistent token is rejected', async () => {
    const result = await lookupToken('this-token-was-never-issued', 'password_reset');
    assert.equal(result.valid, false);
  });

  test('an expired token is rejected even though it otherwise matches', async () => {
    const user = await makeUser('token-expired@example.com');
    const raw = createToken(user.id, 'password_reset');

    // Simulate time passing by directly backdating expiresAt, rather than
    // waiting out the real 15-minute window in a test.
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.userId, user.id));

    const result = await lookupToken(raw, 'password_reset');
    assert.equal(result.valid, false);
  });

  test('a token can only be used once', async () => {
    const user = await makeUser('token-single-use@example.com');
    const raw = createToken(user.id, 'password_reset');

    const first = await lookupToken(raw, 'password_reset');
    assert.equal(first.valid, true);
    transaction((tx) => consumeToken(first.tokenId!, tx));

    const second = await lookupToken(raw, 'password_reset');
    assert.equal(second.valid, false, 'a consumed token should no longer validate');
  });

  test('issuing a new token of the same kind cancels the earlier one', async () => {
    const user = await makeUser('token-replaced@example.com');
    const older = createToken(user.id, 'email_verify');
    const newer = createToken(user.id, 'email_verify');
    assert.equal((await lookupToken(older, 'email_verify')).valid, false);
    assert.equal((await lookupToken(newer, 'email_verify')).valid, true);
  });

  test('lookupResetOrInviteToken finds an invite_setup token without being told the purpose', async () => {
    const user = await makeUser('token-invite@example.com');
    const raw = createToken(user.id, 'invite_setup');
    const result = await lookupResetOrInviteToken(raw);
    assert.equal(result.valid, true);
    assert.equal(result.purpose, 'invite_setup');
  });

  test('lookupResetOrInviteToken finds a password_reset token too', async () => {
    const user = await makeUser('token-reset@example.com');
    const raw = createToken(user.id, 'password_reset');
    const result = await lookupResetOrInviteToken(raw);
    assert.equal(result.valid, true);
    assert.equal(result.purpose, 'password_reset');
  });
});

describe('lifetimeText', () => {
  test("describes each link's lifetime in words, as its email shows it", () => {
    assert.equal(lifetimeText('invite_setup'), '48 hours');
    assert.equal(lifetimeText('password_reset'), '15 minutes');
    assert.equal(lifetimeText('email_verify'), '24 hours');
  });
});

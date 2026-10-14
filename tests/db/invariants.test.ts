import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { applyMigrations } from '../helpers/db.js';
import { db } from '../../src/db/client.js';
import { users, companies, reviews, favorites } from '../../src/db/schema.js';
import { isLastAdmin } from '../../src/routes/account.js';

before(async () => {
  await applyMigrations();
});

async function makeUser(email: string, role: 'user' | 'admin' = 'user') {
  const [user] = await db.insert(users).values({ email, displayName: 'Test User', role, createdAt: new Date() }).returning();
  return user;
}

async function makeCompany(name: string) {
  const [company] = await db.insert(companies).values({
    name, websiteUrl: `https://${name}.example`, websiteDomain: `${name}.example`, updatedAt: new Date(),
  }).returning();
  return company;
}

describe('one review per user per company', () => {
  test('a second review from the same user for the same company is rejected', async () => {
    const user = await makeUser('reviewer@example.com');
    const company = await makeCompany('reviewtest1');

    await db.insert(reviews).values({
      companyId: company.id, userId: user.id, rating: 8, comment: 'first', jobProcessDate: new Date(), createdAt: new Date(),
    });

    await assert.rejects(
      db.insert(reviews).values({
        companyId: company.id, userId: user.id, rating: 4, comment: 'second attempt', jobProcessDate: new Date(), createdAt: new Date(),
      }),
      /UNIQUE constraint failed/,
    );
  });

  test('the same user CAN review two different companies', async () => {
    const user = await makeUser('multi-reviewer@example.com');
    const companyA = await makeCompany('reviewtest2a');
    const companyB = await makeCompany('reviewtest2b');

    await db.insert(reviews).values({
      companyId: companyA.id, userId: user.id, rating: 8, comment: 'a', jobProcessDate: new Date(), createdAt: new Date(),
    });
    await assert.doesNotReject(
      db.insert(reviews).values({
        companyId: companyB.id, userId: user.id, rating: 6, comment: 'b', jobProcessDate: new Date(), createdAt: new Date(),
      }),
    );
  });

  test('two different users CAN each review the same company', async () => {
    const userA = await makeUser('reviewer-a@example.com');
    const userB = await makeUser('reviewer-b@example.com');
    const company = await makeCompany('reviewtest3');

    await db.insert(reviews).values({
      companyId: company.id, userId: userA.id, rating: 8, comment: 'a', jobProcessDate: new Date(), createdAt: new Date(),
    });
    await assert.doesNotReject(
      db.insert(reviews).values({
        companyId: company.id, userId: userB.id, rating: 6, comment: 'b', jobProcessDate: new Date(), createdAt: new Date(),
      }),
    );
  });
});

describe('account deletion cascade behavior', () => {
  test('deleting a user removes their favorites', async () => {
    const user = await makeUser('fav-deleter@example.com');
    const company = await makeCompany('favtest1');
    await db.insert(favorites).values({ userId: user.id, companyId: company.id, createdAt: new Date() });

    await db.delete(users).where(eq(users.id, user.id));

    const remaining = await db.select().from(favorites).where(eq(favorites.companyId, company.id));
    assert.equal(remaining.length, 0);
  });

  test('deleting a user nulls their reviews userId but leaves the review itself', async () => {
    const user = await makeUser('review-deleter@example.com');
    const company = await makeCompany('favtest2');
    const [review] = await db.insert(reviews).values({
      companyId: company.id, userId: user.id, rating: 10, comment: 'great', jobProcessDate: new Date(), createdAt: new Date(),
    }).returning();

    // The app is responsible for copying displayName into deletedUserDisplayName
    // before this delete (see account.ts) — this test isolates just the FK
    // behavior the schema itself guarantees.
    await db.delete(users).where(eq(users.id, user.id));

    const [stillThere] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    assert.ok(stillThere, 'the review row should still exist');
    assert.equal(stillThere.userId, null);
  });
});

describe('isLastAdmin', () => {
  test('returns true when there is exactly one admin', async () => {
    // Isolated by using globally-unique emails — this test file's other tests
    // only ever create plain 'user' role accounts, so this is the only admin
    // unless a previous test created one.
    const admin = await makeUser('sole-admin@example.com', 'admin');
    assert.equal(await isLastAdmin(admin.id), true);
  });

  test('returns false when another admin also exists', async () => {
    const adminA = await makeUser('admin-a@example.com', 'admin');
    await makeUser('admin-b@example.com', 'admin');
    assert.equal(await isLastAdmin(adminA.id), false);
  });

  test('returns false for a regular user regardless of admin count', async () => {
    const user = await makeUser('not-an-admin@example.com', 'user');
    assert.equal(await isLastAdmin(user.id), false);
  });
});

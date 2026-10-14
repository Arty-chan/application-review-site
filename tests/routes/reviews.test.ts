import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { companies, reviews, reviewFlags, users } from '../../src/db/schema.js';
import { startServer, TestClient, createUser, resultNames, TEST_PASSWORD } from '../helpers/http.js';
import { reviewsConfig } from '../../src/config/company-attributes.js';

let baseUrl: string;
let close: () => Promise<void>;
let author: TestClient;
let otherUser: TestClient;
let admin: TestClient;

before(async () => {
  ({ baseUrl, close } = await startServer());
  // One signed-in client per role, shared across tests (the login rate limiter
  // allows 10 attempts per window, so tests don't each log in from scratch).
  [author, otherUser, admin] = await Promise.all([
    signIn('user'), signIn('user'), signIn('admin'),
  ]);
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

let companyCounter = 0;
async function makeCompany() {
  companyCounter += 1;
  const [company] = await db.insert(companies).values({
    name: `Review Target ${companyCounter}`,
    websiteUrl: `https://target${companyCounter}.com`,
    websiteDomain: `target${companyCounter}.com`,
    updatedAt: new Date(),
  }).returning();
  return company;
}

async function postReview(client: TestClient, companyId: number, fields: Record<string, string> = {}) {
  const res = await client.post(`/companies/${companyId}/reviews`, {
    rating: '7', comment: 'Smooth process', jobProcessDate: '2026-09-01', ...fields,
  });
  assert.equal(res.location, `/companies/${companyId}`);
  const review = await db.query.reviews.findFirst({ where: eq(reviews.companyId, companyId) });
  assert.ok(review);
  return review;
}

describe('writing reviews', () => {
  test('a signed-in user can review a company', async () => {
    const company = await makeCompany();
    await postReview(author, company.id);

    const detail = await author.get(`/companies/${company.id}`);
    assert.match(detail.text, /Smooth process/);
    assert.match(detail.text, /3\.5 \/ 5 \(1 rating\)/, 'the 1-10 rating is shown as stars out of 5');
  });

  test('the rating is optional, and unrated reviews are left out of the average', async () => {
    const company = await makeCompany();
    const unrated = await postReview(author, company.id, { rating: '', comment: 'Never heard back' });
    assert.equal(unrated.rating, null);
    await otherUser.post(`/companies/${company.id}/reviews`, { rating: '6', comment: 'Rated one' });

    const detail = await author.get(`/companies/${company.id}`);
    assert.match(detail.text, /No rating/);
    assert.match(detail.text, /3 \/ 5 \(1 rating\)/);
  });

  test("the public sees reviews and ratings, with reviewers' names masked", async () => {
    const company = await makeCompany();
    const review = await postReview(author, company.id, { rating: '8', comment: 'Visible to everyone' });
    const name = (await db.query.users.findFirst({ where: eq(users.id, review.userId!) }))!.displayName!;

    const detail = await new TestClient(baseUrl).get(`/companies/${company.id}`);
    assert.match(detail.text, /Visible to everyone/);
    assert.match(detail.text, /4 \/ 5 \(1 rating\)/);
    assert.match(detail.text, /\[Masked\]/);
    assert.ok(!detail.text.includes(name), "the reviewer's name never reaches the page");

    assert.ok((await otherUser.get(`/companies/${company.id}`)).text.includes(name), 'signed in, names show');
  });

  test('switched to signed-in only, the public sees no reviews or ratings', async () => {
    const company = await makeCompany();
    await postReview(author, company.id, { rating: '8', comment: 'Members only comment' });

    reviewsConfig.visibility = 'user';
    try {
      const detail = await new TestClient(baseUrl).get(`/companies/${company.id}`);
      assert.doesNotMatch(detail.text, /Members only comment/);
      assert.doesNotMatch(detail.text, /\(1 rating\)/);
      assert.match(detail.text, /to see ratings, reviews/);
      assert.match((await otherUser.get(`/companies/${company.id}`)).text, /Members only comment/);
    } finally {
      reviewsConfig.visibility = 'public';
    }
  });

  test('a second review of the same company goes to editing the first instead', async () => {
    const company = await makeCompany();
    const first = await postReview(author, company.id);

    const res = await author.post(`/companies/${company.id}/reviews`, { rating: '2', comment: 'Again' });
    assert.equal(res.location, `/companies/${company.id}/reviews/${first.id}/edit`);
    assert.equal((await db.select().from(reviews).where(eq(reviews.companyId, company.id))).length, 1);
  });

  test('the author can edit their review', async () => {
    const company = await makeCompany();
    const review = await postReview(author, company.id);

    assert.equal((await author.get(`/companies/${company.id}/reviews/${review.id}/edit`)).status, 200);
    const res = await author.post(`/companies/${company.id}/reviews/${review.id}`, { rating: '10', comment: 'Even better on reflection' });
    assert.equal(res.location, `/companies/${company.id}`);

    const updated = await db.query.reviews.findFirst({ where: eq(reviews.id, review.id) });
    assert.equal(updated?.rating, 10);
    assert.equal(updated?.comment, 'Even better on reflection');
    assert.ok(updated?.editedAt, 'editing records when it happened');
  });

  test('the author can delete their review', async () => {
    const company = await makeCompany();
    const review = await postReview(author, company.id);

    await author.post(`/companies/${company.id}/reviews/${review.id}/delete`);
    assert.equal(await db.query.reviews.findFirst({ where: eq(reviews.id, review.id) }), undefined);
  });

  test("other users cannot edit or delete someone else's review", async () => {
    const company = await makeCompany();
    const review = await postReview(author, company.id);

    assert.equal((await otherUser.get(`/companies/${company.id}/reviews/${review.id}/edit`)).status, 403);
    assert.equal((await otherUser.post(`/companies/${company.id}/reviews/${review.id}/delete`)).status, 403);
    assert.ok(await db.query.reviews.findFirst({ where: eq(reviews.id, review.id) }));
  });

  test("an admin can delete anyone's review", async () => {
    const company = await makeCompany();
    const review = await postReview(author, company.id);

    await admin.post(`/companies/${company.id}/reviews/${review.id}/delete`);
    assert.equal(await db.query.reviews.findFirst({ where: eq(reviews.id, review.id) }), undefined);
  });

  test("the user's own reviews are listed on their reviews page", async () => {
    const company = await makeCompany();
    await postReview(otherUser, company.id);

    const page = await otherUser.get('/account/reviews');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(company.name));
  });
});

describe('flagging reviews', () => {
  test('a flagged review shows up for admins, who can dismiss the flag', async () => {
    const company = await makeCompany();
    const review = await postReview(author, company.id, { rating: '1', comment: 'Suspicious review text' });

    const res = await otherUser.post(`/reviews/${review.id}/flag`, { comment: 'Looks like spam' });
    assert.equal(res.location, `/companies/${company.id}`);

    const flagsPage = await admin.get('/admin/flags');
    assert.equal(flagsPage.status, 200);
    assert.match(flagsPage.text, /Looks like spam/);
    assert.match(flagsPage.text, /Suspicious review text/);

    const flag = await db.query.reviewFlags.findFirst({ where: eq(reviewFlags.reviewId, review.id) });
    assert.equal(flag?.status, 'open');
    await admin.post(`/flags/${flag!.id}/resolve`);
    const dismissed = await db.query.reviewFlags.findFirst({ where: eq(reviewFlags.id, flag!.id) });
    assert.equal(dismissed?.status, 'dismissed');
  });

  test('the flag email goes only to admins who have it switched on', async (t) => {
    const subscribed = await createUser({ role: 'admin' });
    const optedOut = await createUser({ role: 'admin' });
    await db.update(users).set({ notifyOnFlags: false }).where(eq(users.id, optedOut.id));
    const company = await makeCompany();
    const review = await postReview(author, company.id);

    // Without RESEND_API_KEY (as in tests), each email is logged instead of sent.
    const warn = t.mock.method(console, 'warn', () => {});
    await otherUser.post(`/reviews/${review.id}/flag`, { comment: 'Spam' });
    const flagEmails = warn.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.includes('"A review was flagged"'));

    assert.ok(flagEmails.some((line) => line.endsWith(` to ${subscribed.email}`)));
    assert.ok(!flagEmails.some((line) => line.endsWith(` to ${optedOut.email}`)));
  });

  test('regular users cannot see the flags page', async () => {
    assert.equal((await otherUser.get('/admin/flags')).status, 403);
  });
});

describe('no-reply reports', () => {
  test('ticked reports show on the review, and as a public count on the company', async () => {
    const company = await makeCompany();
    await postReview(author, company.id, { comment: 'Never heard back', noReplyAfterApplication: 'true' });
    await postReview(otherUser, company.id, { noReplyAfterApplication: 'true' });

    // Signed in: each review shows the reports it ticked, and only those.
    const signedIn = await admin.get(`/companies/${company.id}`);
    assert.match(signedIn.text, /<span class="tag tag-yes">No reply after application<\/span>/);
    assert.doesNotMatch(signedIn.text, /<span class="tag tag-yes">No reply after a call<\/span>/);

    // Public: the count, on the company page and its search result.
    const anonymous = new TestClient(baseUrl);
    const detail = await anonymous.get(`/companies/${company.id}`);
    assert.match(detail.text, /No reply after application: reported by 2 people/);
    assert.doesNotMatch(detail.text, /No reply after a call: reported/, 'a report nobody made is not shown');

    const card = (await anonymous.get('/')).text.split('company-card').find((c) => c.includes(`href="/companies/${company.id}"`));
    assert.match(card ?? '', /No reply after application: reported by 2 people/);
  });

  test('search can exclude companies with no-reply reports', async () => {
    const reported = await makeCompany();
    const unreported = await makeCompany();
    await postReview(author, reported.id, { noReplyAfterCall: 'true' });
    await postReview(author, unreported.id);

    const names = resultNames((await new TestClient(baseUrl).get('/?exclude=noReplyAfterCall')).text);
    assert.ok(!names.includes(reported.name));
    assert.ok(names.includes(unreported.name));
  });
});

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyMigrations } from './db.js';
import { app } from '../../src/app.js';
import { db } from '../../src/db/client.js';
import { users, regions, countries, industries } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/passwords.js';

// HTTP-level test support: the real app (every middleware, CSRF and sessions
// included) on a random port, driven with fetch. Each test file runs in its own
// process with its own in-memory database (see tests/setup.ts).
//
// The session store starts an un-unref'd cleanup interval, so the test script
// passes --test-force-exit to let each file's process end once its tests finish.

export async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await applyMigrations();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface TestResponse {
  status: number;
  location: string | null;
  headers: Headers;
  text: string;
}

type FormFields = Record<string, string | string[]>;

/** A browser stand-in: remembers its session cookie and supplies a CSRF token on every POST. */
export class TestClient {
  private cookie = '';

  constructor(private readonly baseUrl: string) {}

  async get(path: string): Promise<TestResponse> {
    return this.request('GET', path);
  }

  /** Submits a form the way the browser would, including the session's CSRF token. */
  async post(path: string, fields: FormFields = {}): Promise<TestResponse> {
    return this.request('POST', path, { _csrf: await this.csrfToken(), ...fields });
  }

  /** Submits a form with no CSRF token at all. */
  async postWithoutCsrf(path: string, fields: FormFields = {}): Promise<TestResponse> {
    return this.request('POST', path, fields);
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.post('/login', { email, password });
    assert.equal(res.status, 302, `login as ${email} should redirect`);
  }

  private async csrfToken(): Promise<string> {
    // Any page with a form will do; this one renders one whether or not you're signed in.
    const page = await this.get('/forgot-password');
    const match = page.text.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, 'expected a CSRF token on the page');
    return match[1];
  }

  private async request(method: string, path: string, fields?: FormFields): Promise<TestResponse> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;

    let body: URLSearchParams | undefined;
    if (fields) {
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) {
        for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
      }
    }

    const res = await fetch(this.baseUrl + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      if (c.startsWith('connect.sid=')) this.cookie = c.split(';')[0];
    }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  }
}

// ---------- Fixtures ----------

export const TEST_PASSWORD = 'test-password-123';

let userCounter = 0;

/** Inserts an activated account directly, skipping the invite flow. */
export async function createUser(opts: { role?: 'user' | 'admin'; displayName?: string } = {}) {
  userCounter += 1;
  const [user] = await db.insert(users).values({
    email: `user${userCounter}@example.test`,
    passwordHash: await hashPassword(TEST_PASSWORD),
    displayName: opts.displayName ?? `Test User ${userCounter}`,
    role: opts.role ?? 'user',
    createdAt: new Date(),
  }).returning();
  return user;
}

/** A small slice of the real region tree plus a couple of industries — enough for
 * the company form and the search filters to have something to work with. */
export async function seedReferenceData() {
  const [europe] = await db.insert(regions).values({ name: 'EMEA' }).returning();
  const [americas] = await db.insert(regions).values({ name: 'AMER' }).returning();
  await db.insert(countries).values([
    { code: 'DE', name: 'Germany', regionId: europe.id },
    { code: 'FR', name: 'France', regionId: europe.id },
    { code: 'US', name: 'United States', regionId: americas.id },
  ]);
  const [software] = await db.insert(industries).values({ name: 'Software' }).returning();
  const [finance] = await db.insert(industries).values({ name: 'Finance' }).returning();
  return { europe, americas, software, finance };
}

/** Fails if a form sits inside another: browsers ignore the inner one, so its
 * button would submit the outer form instead — which no HTTP-level test sees. */
export function assertNoNestedForms(html: string): void {
  let depth = 0;
  for (const [tag] of html.matchAll(/<\/?form\b/g)) {
    depth += tag.startsWith('</') ? -1 : 1;
    assert.ok(depth <= 1, 'a form inside another form');
  }
}

/** Company names shown as results on a list page. */
export function resultNames(html: string): string[] {
  return [...html.matchAll(/<h2><a href="\/companies\/\d+">([^<]+)<\/a><\/h2>/g)].map((m) => m[1]);
}

/** The company id from a "/companies/:id" redirect after creating one. */
export function companyIdFrom(res: TestResponse): number {
  const match = res.location?.match(/^\/companies\/(\d+)$/);
  assert.ok(match, `expected a redirect to a company page, got ${res.status} ${res.location}`);
  return Number(match[1]);
}

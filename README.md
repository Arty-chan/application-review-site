# Hiring and Application Process Review Site

A site for viewing and reviewing companies' application and hiring process,
plus the regions where they hire.

## Stack

Express 5 + Drizzle ORM + SQLite + Nunjucks templates + plain CSS (and a few
lines of vanilla JS), deployed as a single Docker container behind Caddy.

## Status

Functionally complete for a first local run-through: auth (invite-only
registration, login, password reset), companies (add/edit/search/filter/sort),
reviews (add/edit/delete/flag), favorites, account management (self-service
and admin-on-behalf-of), and an Admin page (`/admin`) for flag moderation,
adding users, choosing who can see what, and bulk import of companies from
pasted CSV are all built and have been exercised end to end against a real
database.

Known gaps, worth knowing about before you rely on this:

- **Emails are matched exactly as typed** — `Alice@example.com` and
  `alice@example.com` are different accounts as far as login and invites are
  concerned.
- **A pending invite can't be re-sent** — inviting an address that was invited
  but never activated reports it as "already a member".
- **The Docker image itself hasn't been built yet** — the machine this was
  last checked on can't run Docker. Everything the image does has been run
  directly on Node 26.10 (the image's version): `npm ci`, the full test suite,
  migrate/seed/create-admin, `npm run build`, and the production server behind
  a simulated Caddy (secure cookie, login). Still, check `/healthz` and a login
  after the first `docker compose up --build` on the VPS.

## Local setup

Needs Node 22 or newer (the Docker image uses Node 26). Works on Windows,
macOS and Linux — no C++ toolchain needed (see `.npmrc` for why). Run these in
Command Prompt on Windows, or Terminal on macOS, from the project folder.

```bash
npm install
```

Create your `.env` from the template — the defaults work as-is for local
development.

On Windows:

```bat
copy .env.example .env
```

On macOS:

```bash
cp .env.example .env
```

Then create the database, fill in the regions/countries and starter
industries, make your admin account (password at least 8 characters), and
start the site:

```bash
npm run db:migrate
npm run seed
npm run create-admin -- you@example.com yourpassword "Your Name"
npm run dev
```

**Note**: You can choose a different port number other than 6559. Just make sure to update all instances.

The site is at http://localhost:6559 — stop it with Ctrl+C. (On Windows, the
first run may bring up a Windows Firewall prompt for Node; allowing or
cancelling are both fine, since the site is only used on localhost.)

To start over with an empty database, stop the site, delete the `data` folder
(`rmdir /s /q data` on Windows, `rm -rf data` on macOS), then run the last
three steps before `npm run dev` again.

Log in with the admin account you just created. From there: use **Add user**
on the **Admin** page (in the nav bar) to make a second, regular account with
a password you pick, then log in as it in a private window to see the
regular-user experience. Add a company, leave a review, try the search filters. With `RESEND_API_KEY` left
empty, no email is sent — invite, reset and verify links are printed in the
`npm run dev` console instead.

## Testing

```bash
npm run typecheck
npm test
```

`typecheck` runs TypeScript's checks across `src/`, `tests/` and `scripts/`;
`npm test` runs the test suite with Node's built-in test runner.

Tests run against a genuine in-memory SQLite database (`DATABASE_PATH=:memory:`,
set by `tests/setup.ts`, which is preloaded into every test process) with real
migrations applied fresh per test file — not mocks. They never touch
`data/app.db` and never send email, whatever is in `.env`.

Two layers:

- **Library and schema tests** (`tests/lib`, `tests/db`, `tests/config`) —
  logic that's easy to get subtly wrong and hard to eyeball-check: URL/domain
  normalization for duplicate detection, the region tree's recursive expansion,
  password hashing, the auth-token lifecycle (expiry, single-use,
  purpose-scoping), the visibility rules and saved settings, and schema-level
  invariants (one review per user per company, cascading deletes, the
  last-admin guard).
- **Route tests** (`tests/routes`) — the real Express app, every middleware
  included (sessions, CSRF, auth guards), started on a random port and driven
  over HTTP by a small cookie-keeping client in `tests/helpers/http.ts`. They
  cover the main flow of each feature: login/logout, password reset, invites,
  the Admin page (adding users, visibility settings), adding/editing/
  searching/sorting/deleting companies,
  CSV import, reviews (including who can read them), flags, no-reply reports,
  favorites, account settings and roles — plus the basic permission checks
  (signed-out visitors, other users, non-admins).

The route tests deliberately stick to the standard paths rather than edge
cases. Note the login rate limiter (10 attempts per 15 minutes) applies in
tests too; each test file runs in its own process, so it only matters within
one file — share a signed-in client between tests rather than logging in for
each one (see `tests/routes/reviews.test.ts`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with auto-reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` and copy the views alongside |
| `npm start` | Run the compiled build (what the Docker image does) |
| `npm run typecheck` | Type-check `src/`, `tests/` and `scripts/` |
| `npm test` | Run the automated test suite |
| `npm run seed` | Make regions/countries match `scripts/data/regions.json` exactly (adds, moves, removes) and add any missing industries from `industries.json`. Safe to rerun after editing either file; it won't remove a country a company still lists. |
| `npm run create-admin -- <email> <password> "<name>"` | Bootstrap the first admin account |
| `npm run db:generate` | Diff `src/db/schema.ts` against the last migration and write a new one |
| `npm run db:migrate` | Apply any unapplied migrations to the database |
| `npm run db:studio` | Drizzle's local DB browser/GUI |

### Changing the database

When you change `src/db/schema.ts`, on your own computer:

1. `npm run db:generate` writes a new migration — a plain, readable `.sql` file
   in `src/db/migrations/`. Open it and check it does what you expect.
2. `npm run db:migrate` applies it to your local database.
3. Commit the migration together with the code that needs it.

Every other copy of the database only needs step 2, since the migration is
already written: your own after pulling a change that includes one, and the
live site's. On the VPS, follow "To deploy an update" below, which backs the
database up first.

Most changes (a new table or column) generate a single `CREATE` or `ALTER`
statement. Changing an existing column (making it optional, say) makes Drizzle
rebuild the whole table, with a `DROP TABLE` — and on SQLite, dropping a table
can also delete the rows of other tables that point at it. If a migration
contains `DROP TABLE`, try it on a copy of the database first and check
nothing else lost rows.

### The `overrides` entry in package.json

drizzle-kit (the migration tool, dev-only) still lists a deprecated package,
`@esbuild-kit/core-utils`, which pins an old esbuild that `npm audit` flags
(GHSA-67mh-4wv8-2f99, an issue in esbuild's dev server). drizzle-kit never
actually loads that package and nothing here runs esbuild's dev server, so it
was never exploitable — the override just points it at the patched esbuild
drizzle-kit already uses, so installs stay warning-free and a real future
warning isn't lost in the noise. Don't use `npm audit fix --force` for it: that
"fix" downgrades drizzle-kit to 0.18, which breaks migrations. Once a
drizzle-kit release drops `@esbuild-kit`, the override can be deleted.

## Project structure

```
src/
  app.ts                       Express setup — middleware, routers, error handler
  index.ts                     Entrypoint — starts app.ts listening (kept separate
                                so tests can import the app without a port)
  db/
    schema.ts                  Full data model (Drizzle)
    client.ts                  DB connection (WAL mode, foreign keys on), plus
                                transaction() — use it whenever a request writes
                                more than one thing (read its comment first:
                                the callback must be synchronous)
    migrations/                Generated SQL migrations — don't hand-edit
  config/
    site.ts                    Site-wide settings: the site's name (every page
                                title, the nav bar, the emails), the minimum
                                password length, and the longest display name.
    company-attributes.ts      Registry of company attributes (tri-state tags like
                                "Posts ghost jobs"), review reports ("No reply
                                after application"), company notes, and the
                                reviews themselves, with each one's default
                                visibility. Admins choose
                                who sees each one on the Admin page (saved in the
                                database — see lib/visibility.ts). Reviewers' names
                                are always signed-in only ("[Masked]" otherwise).
  lib/                         Framework-agnostic logic: passwords, tokens, email,
                                sessions, the shared account-form rules, who can
                                see what, domain normalization, region tree helpers
  middleware/                  Auth guards, CSRF, rate limiting
  routes/                      Route handlers, grouped by resource
  views/                       Nunjucks templates (base.njk + _macros.njk shared
                                across pages)
public/
  styles.css                   Plain CSS — no build step, deliberately no Tailwind
  app.js                       The little client-side JS there is (delete
                                confirmations; re-sorting the search results as
                                soon as the sort changes; the region picker's
                                selected count, select/deselect all, and
                                remembered open/closed state). Must stay a static file: the
                                Content-Security-Policy blocks inline <script>
                                and onclick=/onsubmit=.
scripts/
  seed.ts                      Region/country/industry seed script
  create-admin.ts              Creates the first admin — a command-line script,
                                since no one can sign in to an empty site to do
                                it. After that, admins use Add user on the site.
  data/                        Region tree and industries as editable JSON
tests/                         Mirrors src/'s structure; see "Testing" above
data/                          SQLite lives here at runtime. Gitignored.
```

## Deploying

The deploy instructions assume you're using a VPS with Caddy.

```bash
git clone <this repo> /path/on/vps
cd /path/on/vps
cp .env.example .env    # set APP_URL (https://yourdomain), SESSION_SECRET, RESEND_API_KEY, EMAIL_FROM
mkdir -p data && chown 1000:1000 data   # the app runs as uid 1000, not root (prefix with sudo if you're not root)
docker compose up -d --build
curl http://127.0.0.1:6559/healthz   # {"ok":true}, 
docker compose exec application-review-site npx drizzle-kit migrate
docker compose exec application-review-site npm run seed
docker compose exec application-review-site npm run create-admin -- you@yourdomain.com yourpassword "Your Name"
```

Then add the block from `Caddyfile` to the VPS's own Caddy config (commonly
`/etc/caddy/Caddyfile`), swap `example.com` for your real domain, and
`sudo systemctl reload caddy`. Confirm DNS actually points at the VPS first —
Caddy's automatic HTTPS needs that to issue a certificate. Test through
`https://yourdomain/`, not the bare IP or port 6559 directly — the session
cookie is `secure: true` in production and won't be sent over plain HTTP.

Production-mode behavior, all switched on by `NODE_ENV=production`, which the
Docker image sets (don't put `NODE_ENV` in `.env`):

- The app **refuses to start** if `SESSION_SECRET` is unset or still
  `changeme` — `docker compose logs application-review-site` will say so.
- It **trusts exactly one proxy hop** (Caddy) for the client's IP and HTTPS
  status. That's what lets the secure session cookie be sent and gives the
  rate limiters each visitor's real IP. If you ever put another proxy in front
  of Caddy (a CDN, say), the `trust proxy` setting in `src/app.ts` needs to
  change to match.

To deploy an update, back up the database, then apply any new migrations
before starting the new version — the app doesn't migrate the database by
itself, and new code expects the new schema. The app is stopped meanwhile, so
the backup is a complete copy (while it runs, SQLite keeps its latest writes in
a separate `-wal` file beside the database) and no one uses the new code before
its migration is in:

```bash
git pull
docker compose build
docker compose stop
cp -a data "data-backup-$(date +%F)"   # prefix with sudo if you're not root
docker compose run --rm application-review-site npx drizzle-kit migrate
docker compose up -d
curl http://127.0.0.1:6559/healthz   # {"ok":true}
```

If something goes wrong, the backup folder is a full copy of `data/`: stop the
app, put the backup back in place of `data/`, check out the code you were on
before (`git checkout <commit>`), and `docker compose up -d --build`.

The container binds to `127.0.0.1:6559` only — not reachable from outside the
VPS directly, only through Caddy. `./data` on the host is bind-mounted into
the container, so the SQLite file survives container rebuilds. Back it up
like any single file — a cron job, or [Litestream](https://litestream.io) for
continuous replication.

import './lib/load-env.js';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import nunjucks from 'nunjucks';
import { rawSqlite } from './db/client.js';
import { attachUser } from './middleware/auth.js';
import { csrfSynchronisedProtection, exposeCsrfToken } from './middleware/csrf.js';
import { authRouter } from './routes/auth.js';
import { inviteRouter } from './routes/invites.js';
import { companiesRouter } from './routes/companies.js';
import { reviewsRouter } from './routes/reviews.js';
import { favoritesRouter } from './routes/favorites.js';
import { accountRouter } from './routes/account.js';
import { adminRouter } from './routes/admin.js';
import { SITE_NAME, PASSWORD_MIN_LENGTH, DISPLAY_NAME_MAX_LENGTH } from './config/site.js';

const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

// Fail at boot rather than run in production with a guessable cookie-signing key.
if (isProduction && (!sessionSecret || sessionSecret === 'changeme')) {
  throw new Error('SESSION_SECRET must be set to a long random value in production (see .env.example).');
}

export const app = express();
const SqliteStore = SqliteStoreFactory(session);

// In production the app only ever sees traffic from Caddy, one hop away. Trusting
// that hop is what makes req.secure / req.ip reflect the real client: without it,
// express-session refuses to send the `secure` cookie over the proxied plain-HTTP
// connection (so logins silently don't stick), and the rate limiters would key
// every visitor to Caddy's IP and share one bucket between them.
if (isProduction) {
  app.set('trust proxy', 1);
}

const nunjucksEnv = nunjucks.configure(`${import.meta.dirname}/views`, {
  autoescape: true, // on by default, stated explicitly since it's the whole XSS defense
  express: app,
  // Outside production, re-read templates on every render so edits show up
  // without restarting the server (`npm run dev` only restarts on code changes).
  noCache: !isProduction,
});
app.set('view engine', 'njk');

// Dates are shown as YYYY-MM-DD. In UTC on purpose: dates entered as a day (like
// a review's process date) are stored as UTC midnight, so formatting them in the
// server's local time zone could show the day before.
// Site-wide settings the templates use (see src/config/site.ts).
nunjucksEnv.addGlobal('siteName', SITE_NAME);
nunjucksEnv.addGlobal('passwordMinLength', PASSWORD_MIN_LENGTH);
nunjucksEnv.addGlobal('displayNameMaxLength', DISPLAY_NAME_MAX_LENGTH);

nunjucksEnv.addFilter('isoDate', (date: Date) => date.toISOString().slice(0, 10));

nunjucksEnv.addFilter('urlWithPage', (query: Record<string, unknown>, page: number) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (key === 'page') continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else if (value !== undefined && value !== '') {
      params.append(key, String(value));
    }
  }
  params.set('page', String(page));
  return params.toString();
});

app.use(helmet());
// The CSV import posts a whole spreadsheet as one field, so it gets more than the
// default 100kb. Mounted first: the general parser below skips an already-read body.
app.use('/admin/import', express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(`${import.meta.dirname}/../public`));

app.use(
  session({
    // Clears expired sessions every 15 minutes by default.
    store: new SqliteStore({ client: rawSqlite }),
    secret: sessionSecret ?? 'changeme',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  }),
);

app.use(attachUser);
app.use(exposeCsrfToken);
// Global on purpose: csrf-sync only validates state-changing methods by default
// (GET/HEAD/OPTIONS pass through untouched), so every current and future POST
// route is protected without needing to remember to add this per-route.
app.use(csrfSynchronisedProtection);

app.use(authRouter);
app.use(inviteRouter);
app.use(companiesRouter);
app.use(reviewsRouter);
app.use(favoritesRouter);
app.use(accountRouter);
app.use(adminRouter);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// Catches CSRF rejections and any other thrown/passed error, rather than
// relying on Express's implicit default behavior for anything unhandled.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const isCsrf = (err as { code?: string })?.code === 'EBADCSRFTOKEN';
  console.error(err);
  res.status(isCsrf ? 403 : 500).render('errors/generic', {
    message: isCsrf
      ? 'Your session expired or this form was open too long. Please try again.'
      : 'Something went wrong. Please try again.',
  });
});

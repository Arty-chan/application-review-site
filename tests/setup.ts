// Preloaded into every test process (see the `test` script in package.json),
// before any test file imports src/db/client.ts — so each test file gets its
// own fresh in-memory database instead of touching data/app.db. Set here rather
// than as a `VAR=value` prefix on the npm script, which only works in POSIX shells.
//
// Set unconditionally: load-env.ts never overrides an existing variable, so a
// DATABASE_PATH in .env can't leak through, but one in the shell environment
// could — and tests must never run against a real database file.
process.env.DATABASE_PATH = ':memory:';

// Tests must never send real email. Empty rather than deleted: deleting would let
// a real key in .env fill it back in, whereas an existing (even empty) variable
// is left alone. email.ts treats empty as "not configured" and just logs.
process.env.RESEND_API_KEY = '';
process.env.NODE_ENV = 'test';

import { rawSqlite } from '../db/client.js';

/**
 * Signs a user out everywhere, except the session passed in (the browser making
 * the change) — for after their password changes, so a stolen session or a
 * forgotten signed-in device loses access too.
 *
 * Deletes from the session store's own table (better-sqlite3-session-store:
 * `sessions` with sid, sess JSON, expire). It shares the app's database
 * connection, so called inside transaction() it's part of that transaction.
 */
export function endSessions(userId: number, exceptSessionId = ''): void {
  rawSqlite
    .prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid <> ?")
    .run(userId, exceptSessionId);
}

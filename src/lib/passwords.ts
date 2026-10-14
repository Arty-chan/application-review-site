import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Node's built-in scrypt — no external dependency needed. Deliberately not
// bcrypt: bcrypt is a native module that compiles at install time, pulling in
// build tooling (node-gyp and its dependencies, such as `tar`) that has had
// critical vulnerabilities of its own. scrypt is an equally accepted
// password-hashing algorithm (memory-hard, same family as bcrypt/Argon2) and
// ships in Node core, so it removes that whole class of risk for this one.
//
// Uses the async API, not scryptSync — Node's event loop is single-threaded,
// so a sync call would block every other in-flight request while it hashes.

const KEY_LENGTH = 64;

// OWASP's recommended minimum scrypt cost at a modest 16MB of memory per hash
// (N=2^14, r=8, p=5): p adds CPU cost without adding memory, which matters on a
// small VPS where several logins can hash at once. Stored with each hash, so this
// can be raised later without breaking passwords hashed before.
const COST: ScryptOptions = { N: 2 ** 14, r: 8, p: 5 };

// Hashed against when there's no stored hash to check — see verifyPassword().
const UNUSED_SALT = '0'.repeat(32);

function deriveKey(password: string, salt: string, cost: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, cost, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns "scrypt:N:r:p:salt:hash" — the cost travels with the hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt, key.toString('hex')].join(':');
}

/** With no stored hash (an unknown email, or an invite not yet accepted) this
 * still does a full hash before returning false — so a login's response time
 * doesn't reveal whether the account exists. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    await deriveKey(password, UNUSED_SALT, COST);
    return false;
  }

  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false; // malformed stored value
  const [, N, r, p, salt, hashHex] = parts;

  const storedKey = Buffer.from(hashHex, 'hex');
  const derivedKey = await deriveKey(password, salt, { N: Number(N), r: Number(r), p: Number(p) });

  // timingSafeEqual throws on mismatched lengths rather than returning false —
  // guard explicitly so a corrupt stored hash fails cleanly instead of crashing.
  if (storedKey.length !== derivedKey.length) return false;
  return timingSafeEqual(storedKey, derivedKey);
}

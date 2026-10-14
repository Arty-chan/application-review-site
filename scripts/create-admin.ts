import '../src/lib/load-env.js';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/passwords.js';
import { newPasswordField, displayNameField } from '../src/lib/account-fields.js';

async function main() {
  const [email, password, displayName] = process.argv.slice(2);

  if (!email || !password || !displayName) {
    console.error('Usage: npm run create-admin -- <email> <password> "<display name>"');
    process.exit(1);
  }
  const parsed = z.object({ password: newPasswordField, displayName: displayNameField }).safeParse({ password, displayName });
  if (!parsed.success) {
    console.error(`${parsed.error.issues[0].message}.`);
    process.exit(1);
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    console.error(`A user with email ${email} already exists.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  await db.insert(users).values({
    email,
    passwordHash,
    displayName: parsed.data.displayName,
    role: 'admin',
    createdAt: new Date(),
  });

  console.log(`Admin account created for ${email}.`);
}

await main();

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/lib/passwords.js';

describe('password hashing', () => {
  test('a correct password verifies successfully', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    assert.equal(await verifyPassword('correct-horse-battery-staple', hash), true);
  });

  test('an incorrect password is rejected', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    assert.equal(await verifyPassword('wrong-password', hash), false);
  });

  test('the same password produces a different hash each time (real salting, not a static salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    assert.notEqual(a, b);
  });

  test('stored value records the algorithm and cost alongside the salt and hash', async () => {
    const hash = await hashPassword('whatever');
    assert.match(hash, /^scrypt:\d+:\d+:\d+:[0-9a-f]+:[0-9a-f]+$/);
  });

  test('a malformed or missing stored value fails closed rather than throwing', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-real-hash'), false);
    assert.equal(await verifyPassword('anything', ''), false);
    assert.equal(await verifyPassword('anything', null), false);
  });
});

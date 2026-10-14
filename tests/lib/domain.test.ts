import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, registrableDomain } from '../../src/lib/domain.js';

describe('normalizeUrl', () => {
  test('adds https:// when no protocol is given', () => {
    assert.equal(normalizeUrl('acme.com'), 'https://acme.com');
  });

  test('leaves an existing https:// URL alone', () => {
    assert.equal(normalizeUrl('https://acme.com'), 'https://acme.com');
  });

  test('leaves an existing http:// URL alone (does not force upgrade)', () => {
    assert.equal(normalizeUrl('http://acme.com'), 'http://acme.com');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeUrl('  acme.com  '), 'https://acme.com');
  });
});

describe('registrableDomain', () => {
  test('subdomains resolve to the same registrable domain as the bare domain', () => {
    assert.equal(registrableDomain('https://careers.acme.com'), registrableDomain('https://acme.com'));
  });

  test('www is treated as a subdomain, not part of the registrable domain', () => {
    assert.equal(registrableDomain('https://www.acme.com'), registrableDomain('https://acme.com'));
  });

  test('a path or trailing slash does not affect the result', () => {
    assert.equal(registrableDomain('https://acme.com/careers/engineering'), registrableDomain('https://acme.com/'));
  });

  test('multi-part TLDs are handled correctly (not naive dot-splitting)', () => {
    // A naive "last two dot-segments" approach would incorrectly return "co.uk"
    // for both of these, treating unrelated companies as duplicates.
    assert.equal(registrableDomain('https://acme.co.uk'), 'acme.co.uk');
    assert.notEqual(registrableDomain('https://acme.co.uk'), registrableDomain('https://other.co.uk'));
  });

  test('different companies on different domains are not treated as equal', () => {
    assert.notEqual(registrableDomain('https://acme.com'), registrableDomain('https://widgets.com'));
  });

  test('an invalid URL returns null rather than throwing', () => {
    assert.equal(registrableDomain('not a url at all'), null);
  });
});

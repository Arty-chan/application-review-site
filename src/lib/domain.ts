import { getDomain } from 'tldts';

/** Adds an https:// prefix if the user didn't include a protocol. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Registrable domain (eTLD+1), correctly handling multi-part TLDs and
 * subdomains — careers.acme.com and acme.com both resolve to "acme.com",
 * while acme.co.uk resolves to "acme.co.uk", not "co.uk". This is what
 * duplicate-company detection actually compares.
 */
export function registrableDomain(url: string): string | null {
  return getDomain(url);
}

// Site-wide settings. Each is used everywhere it applies — the pages, the
// server's own checks, the emails, and the create-admin script — so a change
// here is the only change needed.

/** The site's name — in the nav bar, every page's title, and the emails it sends. */
export const SITE_NAME = 'Job Searching is Hard';

/** Passwords need at least this many characters. */
export const PASSWORD_MIN_LENGTH = 8;

/** Display names can be at most this many characters. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

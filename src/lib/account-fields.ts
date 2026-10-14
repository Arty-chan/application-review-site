import { z } from 'zod';
import { PASSWORD_MIN_LENGTH, DISPLAY_NAME_MAX_LENGTH } from '../config/site.js';

// The rules for the fields every account form shares — login, invites, invite
// sign-up, password reset, the account page, Add user, and the create-admin
// script — so they can't drift apart. The forms' own minlength/maxlength come
// from the same settings (see the template globals in app.ts).

export const newPasswordField = z.string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);

export const displayNameField = z.string().trim()
  .min(1, 'Display name is required')
  .max(DISPLAY_NAME_MAX_LENGTH, `Display name can be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);

/** Lowercased, so capitalization never matters: "Alice@Example.com" signs in to
 * the same account as "alice@example.com". Every email is stored this way too. */
export const emailField = z.string().trim().toLowerCase().email('Enter a valid email');

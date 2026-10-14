-- Emails are now lowercased wherever they're typed in (emailField in
-- src/lib/account-fields.ts), so lowercase the ones already stored to match.
UPDATE `users` SET `email` = lower(`email`), `pending_email` = lower(`pending_email`);

import { Resend } from 'resend';
import { SITE_NAME } from '../config/site.js';
import { lifetimeText } from './tokens.js';

const FROM = process.env.EMAIL_FROM ?? 'noreply@example.com';
const APP_URL = process.env.APP_URL ?? 'http://localhost:6559';

/** Every email is a short message built around one link into the app. */
async function send(to: string, subject: string, link: string, html: string) {
  if (!process.env.RESEND_API_KEY) {
    // Lets the whole invite/reset/verify loop be tested locally without a real
    // Resend account — the link that would've been emailed is right here instead.
    console.warn(`[email] RESEND_API_KEY not set — not sending "${subject}" to ${to}`);
    console.warn(`[email] Link: ${link}`);
    return;
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({ from: FROM, to, subject, html });
  if (error) throw new Error(`Failed to send email: ${error.message}`);
}

export async function sendInviteEmail(to: string, token: string): Promise<void> {
  const url = `${APP_URL}/reset-password/${token}`;
  await send(to, `You're invited to ${SITE_NAME}`, url,
    `<p>You've been invited to join ${SITE_NAME}.</p>
     <p><a href="${url}">Set up your account</a> (link expires in ${lifetimeText('invite_setup')}).</p>`);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const url = `${APP_URL}/reset-password/${token}`;
  await send(to, `Reset your ${SITE_NAME} password`, url,
    `<p><a href="${url}">Reset your password</a> (link expires in ${lifetimeText('password_reset')}).</p>
     <p>If you didn't request this, you can ignore this email.</p>`);
}

export async function sendEmailVerification(to: string, token: string): Promise<void> {
  const url = `${APP_URL}/verify-email/${token}`;
  await send(to, 'Verify your new email address', url,
    `<p><a href="${url}">Confirm this email address</a> (link expires in ${lifetimeText('email_verify')}).</p>`);
}

export async function sendFlagNotification(to: string): Promise<void> {
  const url = `${APP_URL}/admin#flags`;
  await send(to, 'A review was flagged', url,
    `<p>A review was flagged for admin attention. <a href="${url}">View open flags</a>.</p>`);
}

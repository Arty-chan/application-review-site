import rateLimit from 'express-rate-limit';

function limiter(windowMinutes: number, limit: number, message: string, failuresOnly = false) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: failuresOnly,
  });
}

export const loginLimiter = limiter(15, 10, 'Too many login attempts. Try again in a few minutes.');
export const forgotPasswordLimiter = limiter(15, 5, 'Too many password reset requests. Try again in a few minutes.');
export const inviteLimiter = limiter(60, 20, 'Too many invites sent. Try again later.');
// Changing an account's email or password checks the current password — counting
// only failed attempts stops that check being brute-forced from a signed-in
// session, without limiting an admin making many legitimate changes.
export const accountChangeLimiter = limiter(15, 10, 'Too many failed attempts. Try again in a few minutes.', true);

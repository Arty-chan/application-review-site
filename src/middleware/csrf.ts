import type { Request, Response, NextFunction } from 'express';
import { csrfSync } from 'csrf-sync';

const { csrfSynchronisedProtection: rawCsrfProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req: Request) => req.body?._csrf,
});

// Wraps csrf-sync's middleware to strip _csrf from the body once validation
// passes. Necessary because route schemas use zod's .strict() to reject
// unexpected fields (so a form can't slip in one like `role`) — without this,
// every strict schema would need to explicitly allow a field it has no actual
// use for, just because of where CSRF happens to transport its token.
export function csrfSynchronisedProtection(req: Request, res: Response, next: NextFunction) {
  rawCsrfProtection(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (req.body && typeof req.body === 'object') delete req.body._csrf;
    next();
  });
}

/** Makes a token available to every view as `csrfToken`, so any form can include
 * <input type="hidden" name="_csrf" value="{{ csrfToken }}">. One token per
 * session — csrf-sync reuses the existing one rather than minting a new one
 * on every request. */
export function exposeCsrfToken(req: Request, res: Response, next: NextFunction) {
  res.locals.csrfToken = generateToken(req);
  next();
}

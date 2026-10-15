import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, reviews } from '../db/schema.js';
import { canView, isAdmin, type Visibility } from '../config/company-attributes.js';

export type CurrentUser = typeof users.$inferSelect;
export type Review = typeof reviews.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
      targetUser?: CurrentUser;
      review?: Review;
    }
  }
}

/** Loads the signed-in user (if any) onto every request. Mounted once, globally,
 * before any guard — the guards below only ever read req.currentUser. Also
 * exposes it to every template as `currentUser`, same pattern as the CSRF token,
 * so individual routes don't need to pass it manually on every render() call. */
export async function attachUser(req: Request, res: Response, next: NextFunction) {
  const userId = req.session.userId;
  if (userId) {
    req.currentUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
  }
  res.locals.currentUser = req.currentUser ?? null;
  next();
}

/** Lets through only the signed-in users a visibility level admits ('user' or
 * 'admin'): anyone signed out goes to the login page, anyone else gets a 403.
 * Pass a function for a level that's an admin setting, so each request reads
 * the current one. */
export function requireLevel(level: Visibility | (() => Visibility)) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.currentUser) return res.redirect('/login');
    if (!canView(typeof level === 'function' ? level() : level, req.currentUser)) {
      return res.status(403).render('errors/403');
    }
    next();
  };
}

export const requireAuth = requireLevel('user');
export const requireAdmin = requireLevel('admin');

/** Must be the user identified by the :id param, or an admin acting on anyone's
 * behalf — this is what lets /users/:id serve both a user's own account page and
 * an admin managing anyone's. Loads that user once and attaches it as
 * req.targetUser so the route handler doesn't need to fetch it again. */
export async function requireSelfOrAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser) return res.redirect('/login');
  const targetId = Number(req.params.id);
  if (req.currentUser.id !== targetId && !isAdmin(req.currentUser)) {
    return res.status(403).render('errors/403');
  }
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) return res.status(404).render('errors/404');
  req.targetUser = target;
  next();
}

/** Must own the review identified by :reviewId, or be an admin. Loads the
 * review once and attaches it as req.review so the route handler doesn't
 * need to fetch it again. */
export async function requireReviewOwnerOrAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser) return res.redirect('/login');
  const reviewId = Number(req.params.reviewId);
  const review = await db.query.reviews.findFirst({ where: eq(reviews.id, reviewId) });
  if (!review) return res.status(404).render('errors/404');
  if (review.userId !== req.currentUser.id && !isAdmin(req.currentUser)) {
    return res.status(403).render('errors/403');
  }
  req.review = review;
  next();
}

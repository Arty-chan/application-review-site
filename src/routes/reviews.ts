import { Router, type Response } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reviews, companies, users, reviewFlags } from '../db/schema.js';
import { requireAuth, requireReviewOwnerOrAdmin, type Review } from '../middleware/auth.js';
import { sendFlagNotification } from '../lib/email.js';
import { reviewReports, reviewsConfig } from '../config/company-attributes.js';

export const reviewsRouter = Router();

// A checkbox submits 'true' when ticked and nothing at all when not.
const checkbox = z.literal('true').optional().transform((v) => v === 'true');

const reviewSchema = z.object({
  // Optional — a review may only report "no reply". The form's "No rating"
  // option submits an empty value; either way it's stored as null.
  rating: z.string().optional()
    .transform((v) => (v ? Number(v) : null))
    .pipe(z.number().int().min(1).max(10).nullable()),
  comment: z.string().trim().min(1, 'A comment is required').max(5000),
  jobProcessDate: z.string().optional(),
  // See reviewReports in src/config/company-attributes.ts.
  noReplyAfterApplication: checkbox,
  noReplyAfterCall: checkbox,
}).strict();

/** The review's column values from a validated form. */
function reviewValues({ jobProcessDate, ...fields }: z.infer<typeof reviewSchema>) {
  return { ...fields, jobProcessDate: parseJobProcessDate(jobProcessDate) };
}

function parseJobProcessDate(input: string | undefined): Date {
  if (!input) return new Date();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function renderReviewForm(res: Response, review: Review, error?: string) {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, review.companyId) });
  res.status(error ? 400 : 200).render('reviews/edit', {
    company, review, error, reviewReports, reviewVisibility: reviewsConfig.visibility,
  });
}

reviewsRouter.post('/companies/:id/reviews', requireAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) return res.status(404).render('errors/404');

  const existing = await db.query.reviews.findFirst({
    where: and(eq(reviews.companyId, companyId), eq(reviews.userId, req.currentUser!.id)),
  });
  if (existing) {
    return res.redirect(`/companies/${companyId}/reviews/${existing.id}/edit`);
  }

  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect(`/companies/${companyId}`);

  await db.insert(reviews).values({
    ...reviewValues(parsed.data),
    companyId,
    userId: req.currentUser!.id,
    createdAt: new Date(),
  });

  res.redirect(`/companies/${companyId}`);
});

// The routes below act on req.review (loaded by requireReviewOwnerOrAdmin) and
// use its own companyId rather than the URL's :id.

reviewsRouter.get('/companies/:id/reviews/:reviewId/edit', requireReviewOwnerOrAdmin, async (req, res) => {
  await renderReviewForm(res, req.review!);
});

reviewsRouter.post('/companies/:id/reviews/:reviewId', requireReviewOwnerOrAdmin, async (req, res) => {
  const review = req.review!;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return renderReviewForm(res, review, parsed.error.issues[0]?.message ?? 'Invalid submission.');

  await db.update(reviews)
    .set({ ...reviewValues(parsed.data), editedAt: new Date() })
    .where(eq(reviews.id, review.id));

  res.redirect(`/companies/${review.companyId}`);
});

reviewsRouter.post('/companies/:id/reviews/:reviewId/delete', requireReviewOwnerOrAdmin, async (req, res) => {
  await db.delete(reviews).where(eq(reviews.id, req.review!.id));
  res.redirect(`/companies/${req.review!.companyId}`);
});

const flagSchema = z.object({ comment: z.string().trim().min(1, 'Please describe the issue').max(2000) }).strict();

reviewsRouter.post('/reviews/:reviewId/flag', requireAuth, async (req, res) => {
  const reviewId = Number(req.params.reviewId);
  const review = await db.query.reviews.findFirst({ where: eq(reviews.id, reviewId) });
  if (!review) return res.status(404).render('errors/404');

  const parsed = flagSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.redirect(`/companies/${review.companyId}`);
  }

  await db.insert(reviewFlags).values({
    reviewId,
    flaggedByUserId: req.currentUser!.id,
    comment: parsed.data.comment,
    createdAt: new Date(),
  });

  const admins = await db.query.users.findMany({ where: and(eq(users.role, 'admin'), eq(users.notifyOnFlags, true)) });
  await Promise.all(admins.map((a) => sendFlagNotification(a.email)));

  res.redirect(`/companies/${review.companyId}`);
});

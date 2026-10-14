import { Router } from 'express';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { favorites, companies } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';

export const favoritesRouter = Router();

favoritesRouter.post('/companies/:id/favorite', requireAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!await db.query.companies.findFirst({ where: eq(companies.id, companyId) })) {
    return res.status(404).render('errors/404');
  }

  await db.insert(favorites).values({
    userId: req.currentUser!.id,
    companyId,
    createdAt: new Date(),
  }).onConflictDoNothing();
  res.redirect(`/companies/${companyId}`);
});

favoritesRouter.post('/companies/:id/favorite/delete', requireAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  await db.delete(favorites).where(
    and(eq(favorites.userId, req.currentUser!.id), eq(favorites.companyId, companyId)),
  );
  res.redirect(`/companies/${companyId}`);
});

// Private to each user — never exposed for admins to browse others' lists.
favoritesRouter.get('/account/favorites', requireAuth, async (req, res) => {
  const rows = await db.select({ company: companies })
    .from(favorites)
    .innerJoin(companies, eq(favorites.companyId, companies.id))
    .where(eq(favorites.userId, req.currentUser!.id))
    .orderBy(asc(companies.name));

  res.render('account/favorites', { companies: rows.map((r) => r.company) });
});

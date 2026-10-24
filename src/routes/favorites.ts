import { Router, type Request, type Response } from 'express';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { favorites, companies } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';

export const favoritesRouter = Router();

/** After toggling: back to the page the button was on (e.g. the search results),
 * if `back` is a page on this site — anything else could send people to another
 * site — or else the company's page. */
function redirectBack(req: Request, res: Response, companyId: number) {
  const back = req.body?.back;
  const isLocalPath = typeof back === 'string' && /^\/(?![/\\])\S*$/.test(back);
  res.redirect(isLocalPath ? back : `/companies/${companyId}`);
}

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
  redirectBack(req, res, companyId);
});

favoritesRouter.post('/companies/:id/favorite/delete', requireAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  await db.delete(favorites).where(
    and(eq(favorites.userId, req.currentUser!.id), eq(favorites.companyId, companyId)),
  );
  redirectBack(req, res, companyId);
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

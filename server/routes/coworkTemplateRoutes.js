// @typecheck strict
/**
 * Templates from your organisation (usecases/coworkTemplates.mts), under /api/cowork:
 *
 *   GET    /templates          → the templates of the caller's organisation (none without one)
 *   GET    /templates/:id      → one of them: its brief, its schedule and what its plan may do, worked out now
 *   POST   /:id/save-as-template → { title? }: save the caller's item as a template of their organisation (its owner)
 *   POST   /templates/:id/use  → a new item of the caller's from it: paused, its plan not approved. Runs nothing.
 *   DELETE /templates/:id      → delete it (the one who saved it, or an administrator of the organisation)
 *   GET    /templates/:id/package → it as a package file, signed by this installation (usecases/coworkPackages.mts)
 *   POST   /packages/preview  → { package }: what a package file holds and may do, after its signature is checked
 *   POST   /packages/add      → { package }: a new, paused item of the caller's from it, its plan not approved
 *
 * A template of another organisation answers 404. Mounted by ./coworkSideRoutes.js, before the item routes and
 * behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

const TITLE_TEXT = 'title is the name of the template (1 to 120 characters).';
const SaveBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    title: z.string({ error: TITLE_TEXT }).trim().min(1, { error: TITLE_TEXT }).max(120, { error: TITLE_TEXT }).optional(),
}).strict());
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
const IdParams = z.object({ id: z.string().min(1).max(200) }).strict();
const PACKAGE_TEXT = 'package is the content of a Cowork package file.';
const PackageBody = z.object({ package: z.object({}, { error: PACKAGE_TEXT }).passthrough() }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ loadItem?: typeof loadOwnedItem, templates?: () => Pick<typeof import('../usecases/coworkTemplates.mts'), 'saveAsTemplate' | 'listTemplates' | 'templateView' | 'useTemplate' | 'deleteTemplate'> }} [overrides]
 */
function mountTemplateRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.templates ?? (() => require('../usecases/coworkTemplates.mts'));
    router.get('/templates', async (req, res) => {
        res.json({ templates: await useCase().listTemplates(userIdOf(req)) });
    });
    router.get('/templates/:id', validate({ params: IdParams }), async (req, res) => {
        res.json(await useCase().templateView(userIdOf(req), req.params.id));
    });
    router.post('/templates/:id/use', validate({ params: IdParams, body: NoBody }), async (req, res) => {
        res.json(await useCase().useTemplate(userIdOf(req), req.params.id));
    });
    router.delete('/templates/:id', validate({ params: IdParams }), async (req, res) => {
        res.json(await useCase().deleteTemplate(userIdOf(req), req.params.id));
    });
    const packages = () => require('../usecases/coworkPackages.mts');
    router.get('/templates/:id/package', validate({ params: IdParams }), async (req, res) => {
        const pkg = await packages().packageOf(userIdOf(req), req.params.id);
        res.setHeader('Content-Disposition', `attachment; filename="cowork-${req.params.id}.json"`);
        res.json(pkg);
    });
    router.post('/packages/preview', validate({ body: PackageBody }), async (req, res) => {
        res.json((await packages().previewPackage(req.body.package)).preview);
    });
    router.post('/packages/add', validate({ body: PackageBody }), async (req, res) => {
        res.json(await packages().addPackage(userIdOf(req), req.body.package));
    });
    router.post('/:id/save-as-template', validate({ params: IdParams, body: SaveBody }), async (req, res) => {
        const userId = userIdOf(req);
        const item = await loadItem(req.params.id, userId);
        res.json(await useCase().saveAsTemplate({ item, userId, title: req.body.title ?? null }));
    });
}

module.exports = { mountTemplateRoutes };

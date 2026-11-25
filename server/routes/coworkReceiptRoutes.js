// @typecheck strict
/**
 * Run receipts of a cowork (usecases/coworkReceipts.mts), under /api/cowork:
 *
 *   GET /receipts/key            → the installation's public key (Ed25519), to check a receipt outside Bee Flow
 *   GET /:id/receipts            → the item's chain, newest first, and whether it holds (the owner only)
 *   GET /:id/runs/:runId/receipt → one run's receipt (the owner only)
 *
 * A receipt holds names and counts, never what a run read or wrote. Mounted by ./coworkSideRoutes.js, before the item
 * routes and behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

const RunParams = z.object({ id: z.string().min(1).max(200), runId: z.string().min(1).max(200) }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ loadItem?: typeof loadOwnedItem, receipts?: () => Pick<typeof import('../usecases/coworkReceipts.mts'), 'receiptsOf' | 'receiptOfRun' | 'publicReceiptKey'> }} [overrides]
 */
function mountReceiptRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.receipts ?? (() => require('../usecases/coworkReceipts.mts'));
    router.get('/receipts/key', async (_req, res) => {
        res.json({ key: await useCase().publicReceiptKey() });
    });
    router.get('/:id/receipts', async (req, res) => {
        res.json(await useCase().receiptsOf(await loadItem(req.params.id, userIdOf(req))));
    });
    router.get('/:id/runs/:runId/receipt', validate({ params: RunParams }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await useCase().receiptOfRun(item, req.params.runId));
    });
}

module.exports = { mountReceiptRoutes };

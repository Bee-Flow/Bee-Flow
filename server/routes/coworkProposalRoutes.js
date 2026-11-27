// @typecheck strict
/**
 * What Cowork proposes to change in a cowork's plan (usecases/coworkProposals.mts), under /api/cowork:
 *
 *   GET  /:id/proposals                        → the item's proposals, newest first: a repair or a fixed step, the
 *                                                steps that change, what it may newly do and how its replay came out
 *   POST /:id/proposals/:proposalId/approve    → approve the proposal the caller looked at ({ fingerprint }): its plan
 *                                                becomes the approved one through every check of an approval
 *   POST /:id/proposals/:proposalId/dismiss    → "Not now": the plan stays as it is
 *   POST /:id/plan/restore                     → approve an earlier version of the plan again ({ version }, "Undo";
 *                                                usecases/coworkPlanVersions.mts)
 *
 * A proposal is never applied by itself: only these routes change the plan, and only for the item's owner
 * (usecases/coworkItems.mts). Mounted by ./coworkSideRoutes.js, before the item routes and behind routes/cowork.js's
 * requireAuth and the read-only gate.
 */

const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, wholeNumber } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

const { requireModule } = require('../modules');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const instruction = z.string().trim().min(1).max(2000);
const stepSelection = { stepIds: z.array(z.string().min(1).max(200)).min(1).max(100), fingerprint: z.string().length(64) };
const ChangeBody = z.union([
    bodyOf({ remove: z.object(stepSelection).strict() }, 'Removing steps from a plan'),
    bodyOf({ instruction, scope: z.object(stepSelection).strict().optional() }, 'Changing the steps'),
    bodyOf({ parameter: z.object({ stepId: z.string().min(1).max(200), field: z.enum(['query', 'folder', 'path', 'subject', 'to']),
        before: z.string().max(2000), value: instruction }).strict() }, 'Changing a step setting'),
]);
const FINGERPRINT_TEXT = 'fingerprint is the fingerprint of the proposal you looked at (64 characters).';
const VERSION_TEXT = 'version is the number of an approved version of the plan.';
const ApproveBody = bodyOf({ fingerprint: worded(FINGERPRINT_TEXT).length(64, FINGERPRINT_TEXT) }, 'Approving a proposal');
const DismissBody = bodyOf({}, 'Putting a proposal aside');
const RestoreBody = bodyOf({ version: wholeNumber(VERSION_TEXT, { min: 1, max: 1_000_000 }) }, 'Restoring a plan');
const ConversationBody = bodyOf({
    message: instruction, scope: z.object(stepSelection).strict().optional(), view: z.string().max(24),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) }).strict()).max(6),
}, 'Talking to a Cowork task');
const ItemParams = z.object({ id: z.string().min(1).max(200) }).strict();
const ProposalParams = z.object({ id: z.string().min(1).max(200), proposalId: z.string().min(1).max(200) }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @typedef {{
 *   loadItem: typeof loadOwnedItem,
 *   sharedItem: typeof import('../usecases/coworkShares.mts').sharedItemOf,
 *   proposals: () => Pick<typeof import('../usecases/coworkProposals.mts'), 'proposalsOf' | 'approveProposal' | 'dismissProposal' | 'requestChange'>,
 *   versions: () => Pick<typeof import('../usecases/coworkPlanVersions.mts'), 'restoreVersion'>,
 * }} ProposalRouteDeps
 */

/** @returns {ProposalRouteDeps} */
const defaults = () => ({
    loadItem: loadOwnedItem,
    sharedItem: (userId, itemId) => require('../usecases/coworkShares.mts').sharedItemOf(userId, itemId),
    proposals: () => require('../usecases/coworkProposals.mts'),
    versions: () => require('../usecases/coworkPlanVersions.mts'),
});

/**
 * @param {import('express').Router} router
 * @param {Partial<ProposalRouteDeps>} [overrides]
 */
function mountProposalRoutes(router, overrides = {}) {
    const { loadItem, sharedItem, proposals, versions } = { ...defaults(), ...overrides };
    const limit = perUserRateLimit({ windowMs: 60_000, max: 3, name: 'cowork-owner-change' });
    const questions = perUserRateLimit({ windowMs: 60_000, max: 10, name: 'cowork-step-question' });
    router.post('/:id/conversation', questions, validate({ params: ItemParams, body: ConversationBody }), async (req, res) => {
        const reader = userIdOf(req);
        const streaming = req.get('accept')?.includes('text/event-stream');
        if (req.body.view === 'shared') {
            const view = await sharedItem(reader, req.params.id);
            await require('../core/cowork/spendGate.mts').assertSpendLeft({id: view.item.id, userId: reader});
            const org = await require('../core/llm/modelResolver').resolveEffectiveOrgId(req, {userId: reader});
            /** @param {Parameters<typeof import('../usecases/coworkConversation').converse>[3]} [stream] */
            const answer = stream => require('../usecases/coworkSharedConversation').answerShared(view, {userId:reader, userOrgId:org}, req.body, stream);
            if (streaming) return require('./coworkConversationStream').sendConversation(res, answer);
            return res.json(await answer());
        }
        const item = await loadItem(req.params.id, reader);
        await require('../core/cowork/spendGate.mts').assertSpendLeft(item);
        /** @param {Parameters<typeof import('../usecases/coworkConversation').converse>[3]} [stream] */
        const answer = stream => require('../usecases/coworkConversation').converse(item, req.body, undefined, stream);
        if (streaming) return require('./coworkConversationStream').sendConversation(res, answer);
        res.json(await answer());
    });
    router.post('/:id/proposals', requireModule('automation'), limit, validate({ params: ItemParams, body: ChangeBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        await require('../core/cowork/spendGate.mts').assertSpendLeft(item);
        res.json(await proposals().requestChange(item, req.body));
    });
    router.get('/:id/proposals', validate({ params: ItemParams }), async (req, res) => {
        res.json(await proposals().proposalsOf(await loadItem(req.params.id, userIdOf(req))));
    });
    router.post('/:id/proposals/:proposalId/approve', validate({ params: ProposalParams, body: ApproveBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await proposals().approveProposal({ item, proposalId: req.params.proposalId, fingerprint: req.body.fingerprint }));
    });
    router.post('/:id/proposals/:proposalId/dismiss', validate({ params: ProposalParams, body: DismissBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await proposals().dismissProposal({ item, proposalId: req.params.proposalId }));
    });
    router.post('/:id/plan/restore', validate({ params: ItemParams, body: RestoreBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await versions().restoreVersion({ item, version: req.body.version }));
    });
}

module.exports = { mountProposalRoutes };

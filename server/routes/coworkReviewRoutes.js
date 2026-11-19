// @typecheck strict
/**
 * The review half of /api/cowork (routes/cowork.js mounts it on its own router, behind the same requireAuth):
 *
 *   POST /:id/runs/:runId/review → the owner handles a run that asked for review (cowork_request_review,
 *                                  core/cowork/reviewTool.mts): answer it, and the agent continues in a follow-up
 *                                  run, or close it ("done myself" / "not needed")
 *
 * and the count of runs waiting for review that a list row and GET /:id carry (`openReviewCount`).
 *
 * Ownership first (usecases/coworkItems.mts), the same rule as viewing and editing the item; the use case then only
 * finds the run among THIS item's runs. An answer starts a follow-up run in the same conversation under the same tool
 * policy, never a wider one (usecases/coworkReview.mts); the request answers at once and the run lands in the history.
 */

const { validate } = require('../core/http/validate');
const coworkStore = require('../stores/coworkStore');
const { fallback } = require('../utils/bestEffort');
const { ReviewBody } = require('./coworkSchemas');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

/**
 * Put `openReviewCount` on every item of one user: one query, a count per item. A failed count costs the counts.
 * @param {Array<{ id: string, openReviewCount?: number }>} schedules
 * @param {string} userId
 */
async function withReviewCounts(schedules, userId) {
    const reviews = await coworkStore.getOpenReviewCounts(userId).catch((e) => fallback('routes/coworkReviewRoutes:counts', e, {}));
    for (const s of schedules) s.openReviewCount = /** @type {Record<string, number>} */ (reviews)[s.id] || 0;
}

/** @param {string} id */
const reviewCountOf = (id) => coworkStore.countOpenReviews(id).catch((e) => fallback('routes/coworkReviewRoutes:count', e, 0));

/** @param {import('express').Router} router */
function mountReviewRoutes(router) {
    router.post('/:id/runs/:runId/review', validate({ body: ReviewBody }), async (req, res) => {
        // Mounted behind routes/cowork.js's requireAuth, which guarantees the session user.
        const userId = /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;
        const schedule = await loadOwnedItem(req.params.id, userId);
        const { handleRunReview } = require('../usecases/coworkReview.mts');
        const { action, answer } = req.body;
        res.json(await handleRunReview({ schedule, runId: req.params.runId, userId, action, answer }));
    });
}

module.exports = { mountReviewRoutes, withReviewCounts, reviewCountOf };

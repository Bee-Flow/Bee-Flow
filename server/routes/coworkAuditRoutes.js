// @typecheck strict
/**
 * The trail of /api/cowork (routes/cowork.js mounts this first, right behind requireAuth):
 *
 *   - every change that succeeded is written to the organisation's access audit log (usecases/coworkAudit.mts):
 *     creating, changing, switching on or off and deleting an item, naming, approving, making and taking off its
 *     plan, handling a review. One middleware, so a route added later is not forgotten; the action is read from the
 *     method and the path, the fields from the request through the use case's allow-list;
 *   - GET /:id/audit → the item's trail, for its owner.
 *
 * Only a change that succeeded is written (a 2xx answer). The item of a new one is read from the answer. Making a plan
 * answers with a stream whose status says nothing about how it ended: routes/coworkPlannerRoutes.js writes that entry
 * itself, once the plan exists.
 */

const { loadOwnedItem } = require('../usecases/coworkItems.mts');

/** Mounted behind requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user);

/** Routes beside the items (their first part is no item id): a change there is not a change to an item. */
const SIDE_ROUTES = new Set(['compose', 'daily-mail', 'shared', 'hooks', 'needs-you', 'home', 'policy', 'templates', 'receipts', 'shield', 'packages']);

/**
 * The action a request is, from its method and its path below /api/cowork; null for one that changes nothing.
 * @param {string} method
 * @param {string} path
 * @returns {{ action: import('../usecases/coworkAudit.mts').AuditAction, id: string | null } | null}
 */
function actionOf(method, path) {
    const parts = path.split('/').filter(Boolean);
    const [id = null, ...rest] = parts;
    const tail = rest.join('/');
    if (method === 'POST' && parts.length === 0) return { action: 'cowork.created', id: null };
    if (!id || SIDE_ROUTES.has(id)) return null;
    /** @type {Record<string, import('../usecases/coworkAudit.mts').AuditAction>} */
    const byRoute = {
        'PUT ': 'cowork.updated', 'DELETE ': 'cowork.deleted', 'POST toggle': 'cowork.toggled',
        'PUT plan': 'cowork.plan_attached', 'POST plan/approve': 'cowork.plan_approved', 'DELETE plan': 'cowork.plan_removed',
        'PUT plan/independence': 'cowork.independence_set', 'POST hand-over': 'cowork.handed_over', 'PUT start': 'cowork.start_set', 'PUT plan/trust': 'cowork.trust_set', 'PUT shares': 'cowork.shares_set',
    };
    const direct = byRoute[`${method} ${tail}`];
    if (direct) return { action: direct, id };
    if (method === 'POST' && rest.length === 3 && rest[0] === 'runs' && rest[2] === 'review') return { action: 'cowork.review_handled', id };
    return null;
}

/** The id of an item an answer names (a new item's answer is the item, or carries it). @param {unknown} body */
function idInAnswer(body) {
    const b = /** @type {{ id?: unknown, schedule?: { id?: unknown } } | null} */ (body && typeof body === 'object' ? body : null);
    const id = b?.id ?? b?.schedule?.id;
    return typeof id === 'string' && id ? id : null;
}

/**
 * @typedef {{
 *   record: typeof import('../usecases/coworkAudit.mts').recordCowork,
 *   trail: typeof import('../usecases/coworkAudit.mts').trailOf,
 *   loadItem: typeof loadOwnedItem,
 * }} AuditRouteDeps
 */

/** @returns {AuditRouteDeps} */
const defaults = () => {
    const audit = () => require('../usecases/coworkAudit.mts');
    return { record: (...a) => audit().recordCowork(...a), trail: (...a) => audit().trailOf(...a), loadItem: loadOwnedItem };
};

/**
 * @param {import('express').Router} router
 * @param {Partial<AuditRouteDeps>} [overrides]
 */
function mountAuditRoutes(router, overrides = {}) {
    const { record, trail, loadItem } = { ...defaults(), ...overrides };

    router.use((req, res, next) => {
        const found = actionOf(req.method, req.path);
        if (!found) return next();
        const json = res.json.bind(res);
        /** @type {unknown} */
        let answer = null;
        res.json = (body) => { answer = body; return json(body); };
        res.on('finish', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            const id = found.id ?? idInAnswer(answer);
            if (!id) return;
            const user = userOf(req);
            const fields = req.body && typeof req.body === 'object' ? /** @type {Record<string, unknown>} */ (req.body) : null;
            void record(found.action, id, { userId: user.id, organizationId: user.organizationId ?? null }, fields);
        });
        next();
    });

    router.get('/:id/audit', async (req, res) => {
        const userId = userOf(req).id;
        await loadItem(req.params.id, userId);
        res.json({ entries: await trail(req.params.id, userId) });
    });
}

module.exports = { mountAuditRoutes, actionOf };

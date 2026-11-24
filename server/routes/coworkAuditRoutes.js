// @typecheck strict
/**
 * The trail of /api/cowork (routes/cowork.js mounts this first, right behind requireAuth):
 *
 *   - every change that succeeded is written to the organisation's access audit log (usecases/coworkAudit.mts):
 *     creating, changing, switching on or off and deleting an item, naming, approving, making and taking off its
 *     plan, handling a review, setting, approving the check of or removing its goal, and putting it on a desk, accepting
 *     it there, choosing the role that decides its questions or taking it off (an entry on that cowork's trail). One middleware, so a route added later is not forgotten; the action is read from the
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
const SIDE_ROUTES = new Set(['compose', 'daily-mail', 'shared', 'hooks', 'needs-you', 'home', 'policy', 'templates', 'receipts', 'shield', 'packages', 'habits']);

/** @type {Record<string, import('../usecases/coworkAudit.mts').AuditAction>} `/desks/:id/members/:scheduleId[/…]`, by method and tail. */
const DESK_MEMBER_ACTIONS = {
    'POST accept': 'cowork.desk_accepted', 'PUT ': 'cowork.desk_role_set', 'DELETE ': 'cowork.desk_left',
    'POST hand-off': 'cowork.desk_hand_off_allowed', 'DELETE hand-off': 'cowork.desk_hand_off_withdrawn',
};

/**
 * A desk change that concerns one cowork: an entry on that cowork's trail. `POST /desks/:id/members` names it in its body.
 * @param {string} method
 * @param {string[]} parts
 * @param {unknown} body
 * @returns {{ action: import('../usecases/coworkAudit.mts').AuditAction, id: string | null } | null}
 */
function deskActionOf(method, parts, body) {
    if (parts[2] !== 'members') return null;
    if (method === 'POST' && parts.length === 3) {
        const named = /** @type {{ scheduleId?: unknown } | null} */ (body && typeof body === 'object' ? body : null)?.scheduleId;
        return typeof named === 'string' && named ? { action: 'cowork.desk_joined', id: named } : null;
    }
    const action = DESK_MEMBER_ACTIONS[`${method} ${parts.slice(4).join('/')}`];
    return action && parts[3] ? { action, id: parts[3] } : null;
}

/**
 * The action a request is, from its method and its path below /api/cowork (and, for a desk member, the body that names
 * the cowork); null for one that changes nothing.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {{ action: import('../usecases/coworkAudit.mts').AuditAction, id: string | null } | null}
 */
function actionOf(method, path, body) {
    const parts = path.split('/').filter(Boolean);
    const [id = null, ...rest] = parts;
    const tail = rest.join('/');
    if (method === 'POST' && parts.length === 0) return { action: 'cowork.created', id: null };
    if (id === 'desks') return deskActionOf(method, parts, body);
    if (!id || SIDE_ROUTES.has(id)) return null;
    /** @type {Record<string, import('../usecases/coworkAudit.mts').AuditAction>} */
    const byRoute = {
        'PUT ': 'cowork.updated', 'DELETE ': 'cowork.deleted', 'POST toggle': 'cowork.toggled',
        'PUT plan': 'cowork.plan_attached', 'POST plan/approve': 'cowork.plan_approved', 'DELETE plan': 'cowork.plan_removed',
        // An earlier version approved again ("Restore", "Undo") is an approval too.
        'POST plan/restore': 'cowork.plan_approved',
        'PUT plan/independence': 'cowork.independence_set', 'POST hand-over': 'cowork.handed_over', 'PUT start': 'cowork.start_set', 'PUT plan/trust': 'cowork.trust_set', 'PUT shares': 'cowork.shares_set',
        'PUT goal': 'cowork.goal_set', 'POST goal/approve': 'cowork.goal_check_approved', 'DELETE goal': 'cowork.goal_removed',
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
 * What an approval's answer adds to its entry: the version it made and that version's fingerprint, so the trail can
 * offer to bring exactly that version back (POST /:id/plan/restore). Nothing for any other answer.
 * @param {unknown} answer
 * @returns {Record<string, unknown>}
 */
function approvedIn(answer) {
    const approved = /** @type {{ approved?: { version?: unknown, fingerprint?: unknown } | null } | null} */ (answer && typeof answer === 'object' ? answer : null)?.approved;
    return approved && typeof approved.version === 'number' ? { version: approved.version, fingerprint: approved.fingerprint } : {};
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
        const found = actionOf(req.method, req.path, req.body);
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
            const carried = found.action === 'cowork.plan_approved' ? { ...fields, ...approvedIn(answer) } : fields;
            void record(found.action, id, { userId: user.id, organizationId: user.organizationId ?? null }, carried);
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

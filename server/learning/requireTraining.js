/**
 * requireTraining(areaId) — the express side of an organisation's "finish the
 * course first" rule. See trainingGates.js for what the rule is and the four
 * ways it deliberately does not bite.
 *
 * Mounted next to the capability gate of each area in server/index.js, so it
 * covers every sub-route at once. A gate attached per-handler is a gate someone
 * forgets on the handler added next month.
 *
 * It answers 403 with a body the client can ACT on rather than only display:
 *
 *   { error: 'training_required',
 *     training: { area, courseId, courseTitle, lessonsDone, lessonsTotal } }
 *
 * — enough for "Finish Build Your First Agent (4 of 7 lessons) to unlock this"
 * with a button straight into that course. The same shape is served up-front by
 * GET /ai/learning/training-gates so the client can lock the create button
 * BEFORE the work is done, which is the interaction that actually matters: a
 * 403 at Save means somebody just lost twenty minutes of typing.
 */

const { evaluateAreas, getSettings, AREA_BY_ID } = require('./trainingGates');
const { resolveVisibleByCourse } = require('./visibility');
const { readServerProgress } = require('./certificates');
const { getUserPermissions } = require('../auth/permissions');
const { hasCapability } = require('../core/entitlements/entitlements');

// Reads are never gated — see trainingGates.js. OPTIONS is CORS preflight.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * WHICH writes each area actually locks.
 *
 * "Every non-GET under the mount" is the wrong rule, and /agents shows why:
 * POST /agents/:id/chat lives beside POST /agents. Talking to an agent is the
 * thing the whole product is for, and the training rule is about AUTHORING —
 * so the areas name the authoring paths and everything else falls through.
 *
 * An allow-list rather than a deny-list on purpose. A path nobody listed stays
 * OPEN, so the failure mode of forgetting one is "a write we meant to gate is
 * not gated" — a missing lock, which someone notices and fixes. A deny-list
 * fails the other way: the route added next month is locked by accident, and
 * the report that reaches us is "Bee Flow is broken", from an org that cannot
 * work until we ship.
 *
 * Tested against the real routers in requireTraining.test.js: the operate paths
 * listed there must stay reachable.
 */
const AREA_PATHS = Object.freeze({
    // Create / edit / delete an agent, its wizard and its test set. NOT
    // /:id/chat, /:id/conversations, /:id/favorite — those are using an agent.
    agents: [/^\/$/, /^\/wizard\//, /^\/describe-building$/, /^\/[^/]+$/,
        /^\/[^/]+\/(publish|publish-version|persona|tests)(\/|$)/, /^\/categories(\/|$)/],
    // Knowledge bases: the KB itself, its sources and its reindex.
    knowledge: [/^\/$/, /^\/[^/]+$/, /^\/[^/]+\/(sources|documents|ingest|reindex|categories)(\/|$)/,
        /^\/categories(\/|$)/],
    skills: [/^\/$/, /^\/[^/]+$/],
    // Authoring an automation. NOT /:id/run, /dry-run, /activate, /runs/*,
    // /approvals/*, /webhook/*, /form/:token (the public form) or /events/*.
    automations: [/^\/$/, /^\/import$/, /^\/[^/]+$/, /^\/folders(\/|$)/,
        /^\/[^/]+\/versions\//, /^\/[^/]+\/form$/, /^\/forms\/ai\//],
    // Creating and reshaping a table. NOT /:id/rows — filling a table in is
    // exactly what a colleague's app asks an untrained person to do.
    datatables: [/^\/$/, /^\/[^/]+$/, /^\/[^/]+\/(columns|schema|import|share|retention)(\/|$)/],
    // Building an app. NOT /:id/run, /:id/data, /:id/files, /:id/large-datasets
    // — those are the runtime, used by people who will never open the builder.
    // `datasets` below is the BI saved datasets an author defines; the genome
    // files a person uploads into a running app are /:id/large-datasets, and
    // were gated here only while the two shared a path (until 2026-09-23).
    apps: [/^\/$/, /^\/builder(\/|$)/, /^\/[^/]+$/,
        /^\/[^/]+\/(screens|actions|publish|datasets|connectors)(\/|$)/],
    webpages: [/^\/$/, /^\/[^/]+$/, /^\/[^/]+\/(publish|versions|audience|grants)(\/|$)/],
    playbooks: [/^\/$/, /^\/recipes\/compose$/, /^\/[^/]+$/, /^\/[^/]+\/phases\//],
    meeting_notes: [/^\/$/, /^\/[^/]+$/, /^\/upload$/, /^\/record(\/|$)/],
    cowork: [/^\/$/, /^\/[^/]+$/],
});

/** True when this request is one of the writes `areaId` locks. */
function pathIsGated(areaId, reqPath) {
    const patterns = AREA_PATHS[areaId];
    if (!patterns) return true;
    const p = String(reqPath || '/').replace(/\/+$/, '') || '/';
    return patterns.some((rx) => rx.test(p));
}

const isOrgAdminPerms = (perms) => Array.isArray(perms) && (perms.includes('all') || perms.includes('org_admin'));

/**
 * Evaluate every area for one user. Exported because the route that feeds the
 * client's proactive locks needs exactly this, and computing it twice from two
 * slightly different assemblies is how the button and the 403 start disagreeing.
 *
 * Any failure resolves to "nothing enforced": see the fail-open rule.
 */
async function evaluateForRequest(req, { extraCourses = [] } = {}) {
    const userId = req.session?.user?.id;
    const orgId = req.session?.user?.organizationId || null;
    if (!userId || !orgId) return {};
    try {
        const settings = await getSettings(orgId);
        // Nothing configured: skip the progress and permission round-trips
        // entirely. This is the overwhelmingly common case and it sits on the
        // write path of every builder surface in the product.
        if (!Object.keys(settings.areas).length) return {};

        const [perms, learningAvailable, progressMap, vis] = await Promise.all([
            getUserPermissions(userId, req.session).catch(() => null),
            hasCapability('learning_center', { userId, orgId, session: req.session, req }).catch(() => false),
            readServerProgress(userId).catch(() => ({})),
            resolveVisibleByCourse({ userId, orgId, session: req.session, req })
                .catch(() => ({ visibleByCourse: undefined })),
        ]);
        return evaluateAreas({
            settings,
            progressMap,
            visibleByCourse: vis?.visibleByCourse,
            extraCourses,
            isOrgAdmin: isOrgAdminPerms(perms),
            learningAvailable: !!learningAvailable,
        });
    } catch (_) {
        return {};
    }
}

function requireTraining(areaId) {
    if (!AREA_BY_ID.has(areaId)) throw new Error(`requireTraining: unknown area '${areaId}'`);
    return async function trainingGate(req, res, next) {
        if (SAFE_METHODS.has(req.method)) return next();
        if (!pathIsGated(areaId, req.path)) return next();
        let state;
        try {
            state = (await evaluateForRequest(req))[areaId];
        } catch (_) {
            return next(); // fail open
        }
        if (!state || !state.enforced || state.satisfied) return next();
        return res.status(403).json({
            error: 'training_required',
            message: `Finish the course "${state.courseTitle}" before using this.`,
            training: {
                area: areaId,
                courseId: state.courseId,
                courseTitle: state.courseTitle,
                lessonsDone: state.lessonsDone,
                lessonsTotal: state.lessonsTotal,
            },
        });
    };
}

module.exports = { requireTraining, evaluateForRequest, pathIsGated, AREA_PATHS, SAFE_METHODS };

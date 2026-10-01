/**
 * Route-table freeze for routes/projects.js.
 *
 * Express is first-match, so two things about this router are invariants rather
 * than style, and neither is visible when reading a single handler:
 *
 *  1. ORDERING. `DELETE /conversations/:convId` (a user detaching their OWN
 *     conversation, deliberately requiring no project role) must stay ABOVE the
 *     `/:id` family. Move it below and `/:id` swallows it.
 *
 *  2. THE ROLE GATE ON EVERY ROUTE. Each entry below records which middleware
 *     the route carries. `requireProjectRoleMw` is the shared ladder from
 *     auth/projectAccess.js. A route that loses its gate — by a careless edit,
 *     a merge, or a copy-paste of the wrong handler — becomes open to any
 *     authenticated user, silently and with no failing assertion anywhere else.
 *     That is precisely how the memory routes ended up letting viewers write.
 *
 * Every dependency is mocked, so this never touches the DB or the network.
 *
 * Run: cd server && node --test routes/projects.routetable.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}
mock(path.join(SERVER, 'stores/projectStore'), {});
mock(path.join(SERVER, 'stores/userStore'), {});
mock(path.join(SERVER, 'stores/knowledgeBases'), {});
mock(path.join(SERVER, 'support/kbAccess'), { partitionAccessibleKBIds: async () => ({ allowed: [], denied: [] }) });
mock(path.join(SERVER, 'auth'), { resolveUserGroups: async () => [] });
// The limiter is mocked, so its layer name comes from here. Give it a real name
// so the baseline below records "a rate limiter sits on this route" rather than
// an indistinguishable `<anonymous>`.
mock(path.join(SERVER, 'utils/perUserRateLimit'), {
    perUserRateLimit: () => function rateLimiter(req, res, next) { next(); },
});

const router = require('./projects');

/**
 * Flatten the router into "METHOD /path [middleware,...]" lines. Middleware is
 * captured by function name, which is why requireProjectRole returns a NAMED
 * function — an anonymous arrow would render every gate identically and this
 * test would stop being able to tell them apart.
 */
function flatten(stack) {
    const out = [];
    for (const layer of stack) {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods)
                .filter(m => layer.route.methods[m])
                .map(m => m.toUpperCase())
                .sort()
                .join(',');
            const mws = layer.route.stack
                .slice(0, -1)                      // drop the handler itself
                .map(l => l.name || 'anonymous');
            out.push(`${methods} ${layer.route.path}${mws.length ? ` [${mws.join(',')}]` : ''}`);
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
            out.push(...flatten(layer.handle.stack));
        } else {
            out.push(`USE:${layer.handle && layer.handle.name ? layer.handle.name : 'anonymous'}`);
        }
    }
    return out;
}

// `rateLimiter` is the shared memberMutationLimiter; `requireProjectRoleMw` is
// the shared role gate. Both names are load-bearing for this baseline.
const EXPECTED = [
    // `?kind=workspace|solution` is a closed query: the Projects page and Studio
    // each ask for their side of the split.
    'GET / [validateRequest]',
    'POST / [validateRequest]',
    // The Solutions overview. No role gate BY DESIGN — it answers with a row
    // per project the caller can already see, and listUserProjects IS the
    // authorisation. Like the self-detach route below, it is a one-segment path
    // and must precede /:id or Express hands "summary" to the role gate as a
    // project id.
    'GET /summary [validateRequest]',
    // Self-service detach — no role gate BY DESIGN, and it must precede /:id.
    // It shares a router with the shared-thread routes
    // (routes/projects/threads.js), which therefore come next. Sharing is
    // editor+ AND owner-of-the-conversation (enforced in the handler, because
    // sharing re-encrypts and only the owner holds the key that opens the
    // current ciphertext). Unsharing has no project role BY DESIGN either:
    // only the chat's owner can do it, and must always be able to, member or
    // not (a removed member's shared chat would otherwise block deleting the
    // project for good). `requireOwnThreadMw` is its gate: the caller owns
    // the conversation AND it is filed in THIS project, else 404.
    'DELETE /conversations/:convId [validateRequest]',
    'GET /:id/threads [requireProjectRoleMw,validateRequest]',
    'POST /:id/threads [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/threads/:convId [requireOwnThreadMw,validateRequest]',
    'GET /:id [requireProjectRoleMw]',
    'PUT /:id [requireProjectRoleMw,validateRequest]',
    // Classifying a legacy project as a collaborative project or a Solution
    // (routes/projects/kind.js). Owner only, and once (the backfill's guess
    // may be corrected once): the handler refuses (409) when the owner's kind
    // is set, or while the project holds what the other side cannot hold.
    'PUT /:id/kind [requireProjectRoleMw,validateRequest]',
    'DELETE /:id [requireProjectRoleMw]',
    'POST /:id/share [rateLimiter,requireProjectRoleMw,validateRequest]',
    'DELETE /:id/share/:shareId [rateLimiter,requireProjectRoleMw]',
    'GET /:id/members [requireProjectRoleMw]',
    'PUT /:id/members/:memberId [rateLimiter,requireProjectRoleMw,validateRequest]',
    // Owner-removes / self-leave: the handler decides, so no role gate here.
    'DELETE /:id/members/:memberId [rateLimiter]',
    // A member's uploaded picture, as an image (viewer+; only people of the project).
    'GET /:id/avatars/:userId [requireProjectRoleMw]',
    'GET /:id/activity [requireProjectRoleMw,validateRequest]',
    // Live feed. The stream is viewer+ and re-checks the role periodically
    // while open. (The shared-thread routes are listed with self-detach.)
    'GET /:id/stream [requireProjectRoleMw,validateRequest]',
    // Typing is transient, but every open stream of the project receives it:
    // a per-member limiter keeps a loop from flooding them.
    'POST /:id/typing [requireProjectRoleMw,rateLimiter,validateRequest]',
    // Notebooks / apps / routines / webpages filed into the project, and the
    // approvals raised inside it. Listing is viewer+; moving one in or out is
    // editor+ AND owner-of-the-resource (the stores match on user_id, so a
    // member cannot move a colleague's work). Approvals are not movable at all.
    'GET /:id/resources [requireProjectRoleMw]',
    'PUT /:id/resources [requireProjectRoleMw,validateRequest]',
    // How the Solution is wired to itself — which app runs which routine, which
    // routine asks whom to approve. Viewer+, because it draws lines between
    // entries the Content listing already shows and adds nothing to them.
    'GET /:id/graph [requireProjectRoleMw]',
    // "Te controleren": the aggregated findings and the one verdict the publish
    // button reads. Viewer+ for the same reason as the graph — it names the
    // objects the Content listing already shows and adds the validators'
    // sentences about them, nothing more.
    'GET /:id/completeness [requireProjectRoleMw]',
    // Blueprint packaging is its own router, so it shows up as its routes —
    // but NOT as a `USE:featureGate` line of its own. That shape (a path-less
    // `router.use(requireFeature(...))` on the packaging router) is exactly
    // what let the licence gate leak past every route below: `USE:featureGate`
    // runs for every request the packaging router receives, including one for
    // `PUT /:id/conversations` further down this same file, which matches none
    // of packaging's own routes but still passed through it on the way here.
    // `featureGate` is now the FIRST middleware on each packaging route
    // instead, so it can only ever refuse a request meant for that route.
    // Losing it from any one line below — a careless edit, a copy-paste of the
    // wrong handler — makes that route silently free.
    // Owner, not editor, on top of it — export reads every member's entities,
    // not the caller's own.
    // `stampExport` is the Data Act Art. 30 stamp: it records that an export of
    // this kind ran, so DATA_ACT-Art25-exit-procedure can prove the route is
    // not just mounted but used. It is a recorder, never a gate — the day it
    // replaces `requireProjectRoleMw` on this line, export has lost its gate.
    // `requireSolutionProject` follows the role gate (and the body schema) on
    // every `/:id/package/*` line: a collaborative project carries no
    // Blueprint and answers 404.
    'POST /:id/package/export [featureGate,requireProjectRoleMw,validateRequest,requireSolutionProject,stampExport]',
    // Planning is separate from applying on purpose: "3 will be updated, 1 you
    // edited will be left alone" is a decision, and an upgrade that only tells
    // you afterwards is not offering one. Owner for both — an upgrade rewrites
    // other members' entities.
    'POST /:id/package/upgrade/plan [featureGate,requireProjectRoleMw,validateRequest,requireSolutionProject]',
    'POST /:id/package/upgrade [featureGate,requireProjectRoleMw,validateRequest,requireSolutionProject]',
    // De publicatiegeschiedenis: één rij per uitgave, met per entiteit wat er
    // in die versie veranderde. Eigenaar, en niet lager — wie dit leest leest
    // de inhoudsopgave van élke versie die er ooit is geweest, ook van
    // entiteiten die er nu niet meer in zitten. Dezelfde rol als exporteren.
    'GET /:id/package/releases [featureGate,requireProjectRoleMw,requireSolutionProject]',
    // Hoe vaak deze Oplossing is geïnstalleerd: twee getallen, in de eigen
    // organisatie en elders op deze instantie. De ENIGE plek waar een
    // Blueprint-antwoord over de org-grens heen kijkt, en daarom op de
    // eigenaarsrol van het BRONPROJECT — wie hier binnenkomt is per definitie
    // iemand uit de organisatie die de Blueprint gemaakt heeft.
    'GET /:id/package/installs [featureGate,requireProjectRoleMw,requireSolutionProject]',
    // Install creates a project rather than acting on one, so it carries no
    // project role — only the licence gate and the mount's own.
    'POST /package/install [featureGate,validateRequest]',
    // The gallery: Blueprints kept on this instance so another team can install
    // one without a file passing through anybody's downloads folder. No project
    // role — none of these acts on a project.
    'GET /package/blueprints [featureGate]',
    // One Blueprint WITH its manifest — what the install wizard reads to say
    // what is in the file and what the recipient will have to connect. Same
    // `canRead` predicate the install path uses, so reading one you may
    // install is not a wider permission than installing it.
    'GET /package/blueprints/:blueprintId [featureGate]',
    'DELETE /package/blueprints/:blueprintId [featureGate]',
    // Nothing to do with packaging — and precisely the route the old
    // path-less gate answered 403 `blueprint_packaging` to.
    'PUT /:id/conversations [requireProjectRoleMw,validateRequest]',
    // Team chats (routes/projects/chats.js). Reading is viewer+, writing is
    // editor+; who may edit or delete ONE message or chat (its author, the
    // person who started it, the project owner) is decided in the handler.
    // Starting a chat and posting share one per-member budget, the chat
    // router's own lazily bound `rateLimitMiddleware`.
    'GET /:id/chats [requireProjectRoleMw,validateRequest]',
    'GET /:id/chat-agents [requireProjectRoleMw]',
    'POST /:id/chats [requireProjectRoleMw,rateLimitMiddleware,validateRequest]',
    'GET /:id/chats/:chatId [requireProjectRoleMw]',
    'PATCH /:id/chats/:chatId [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/chats/:chatId [requireProjectRoleMw]',
    'GET /:id/chats/:chatId/messages [requireProjectRoleMw,validateRequest]',
    'POST /:id/chats/:chatId/messages [requireProjectRoleMw,rateLimitMiddleware,validateRequest]',
    'PATCH /:id/chats/:chatId/messages/:messageId [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/chats/:chatId/messages/:messageId [requireProjectRoleMw]',
    // "Not helpful" on an answer the AI gave by itself: any member who can
    // post (editor+), one mark per person per message.
    'GET /:id/chats/:chatId/messages/:messageId/trace [requireProjectRoleMw]',
    'POST /:id/chats/:chatId/messages/:messageId/feedback [requireProjectRoleMw,validateRequest]',
    'POST /:id/chats/:chatId/read [requireProjectRoleMw,validateRequest]',
    // Tasks (routes/projects/tasks.js): reading is viewer+, writing editor+;
    // who may delete one (its author, the project owner) is decided in the handler.
    'GET /:id/tasks [requireProjectRoleMw]',
    // Planning poker (the same router): one session per project. Voting is
    // viewer+ (every member estimates); starting, steering and closing the
    // session is editor+.
    'GET /:id/tasks/poker/session [requireProjectRoleMw]',
    'POST /:id/tasks/poker/session/start [requireProjectRoleMw,validateRequest]',
    'POST /:id/tasks/poker/session/vote [requireProjectRoleMw,validateRequest]',
    'POST /:id/tasks/poker/session/reveal [requireProjectRoleMw,validateRequest]',
    'POST /:id/tasks/poker/session/finish [requireProjectRoleMw,validateRequest]',
    'POST /:id/tasks/poker/session/cancel [requireProjectRoleMw,validateRequest]',
    'POST /:id/tasks/poker/session/next [requireProjectRoleMw,validateRequest]',
    'POST /:id/tasks [requireProjectRoleMw,validateRequest]',
    'POST /:id/tasks/batch [requireProjectRoleMw,validateRequest]',
    'GET /:id/meetings/:meetingId/task-suggestions [requireProjectRoleMw]',
    'POST /:id/meetings/:meetingId/task-suggestions/improve [requireProjectRoleMw,rateLimitMiddleware]',
    'POST /:id/tasks/:taskId/improve [requireProjectRoleMw,rateLimitMiddleware]',
    'PATCH /:id/tasks/:taskId [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/tasks/:taskId [requireProjectRoleMw]',
    // The task router's error mapper (a 4-argument handler, so it flattens to
    // USE:anonymous): the date-range and poker-queue constraints become 400/409.
    'USE:anonymous',
    // Sprints (routes/projects/sprints.js): listing is viewer+, every change is
    // editor+; only one sprint is active at a time (the store demotes the rest).
    'GET /:id/sprints [requireProjectRoleMw]',
    'POST /:id/sprints [requireProjectRoleMw,validateRequest]',
    'PATCH /:id/sprints/:sprintId [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/sprints/:sprintId [requireProjectRoleMw]',
    'POST /:id/sprints/:sprintId/items [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/sprints/:sprintId/items/:taskId [requireProjectRoleMw]',
    'POST /:id/sprints/:sprintId/start [requireProjectRoleMw]',
    'POST /:id/sprints/:sprintId/complete [requireProjectRoleMw]',
    // The sprint router's error mapper: the date-range constraint becomes a 400.
    'USE:anonymous',
    // A person's colour in the project: the owner for anyone, everybody else for themselves (decided in the handler).
    'PUT /:id/members/:userId/color [requireProjectRoleMw,validateRequest]',
    // Project files, "my chats" and presence (routes/projects/workspace.js).
    // The upload is editor+ and rate limited BEFORE multer reads the body;
    // `acceptProjectFile` is multer, one field, one file.
    'GET /:id/files [requireProjectRoleMw,validateRequest]',
    'GET /:id/files/:fileId/content [requireProjectRoleMw,validateRequest]',
    'POST /:id/files [requireProjectRoleMw,rateLimiter,acceptProjectFile]',
    'DELETE /:id/files/:fileId [requireProjectRoleMw,validateRequest]',
    'GET /:id/my-chats [requireProjectRoleMw,validateRequest]',
    'POST /:id/presence [requireProjectRoleMw,rateLimiter,validateRequest]',
    // A new document or notebook made inside the project, owned by the caller
    // (routes/projects/content.js). Editor+, rate limited.
    'GET /:id/search [requireProjectRoleMw,validateRequest]',
    'GET /:id/pins [requireProjectRoleMw]',
    'PUT /:id/pins [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/pins/:type/:itemId [requireProjectRoleMw,validateRequest]',
    'GET /:id/board [requireProjectRoleMw]',
    'PUT /:id/board [requireProjectRoleMw,validateRequest]',
    'POST /:id/board/tasks [requireProjectRoleMw,validateRequest]',
    'PATCH /:id/board/tasks/:taskId [requireProjectRoleMw,validateRequest]',
    'POST /:id/documents [requireProjectRoleMw,rateLimiter,validateRequest]',
    'POST /:id/notebooks [requireProjectRoleMw,requireNotebooksMw,rateLimiter,validateRequest]',
    // Real-time co-editing (routes/projects/collab.js). Opening, syncing and
    // presence are viewer+ (a viewer follows along read-only); posting
    // changes is editor+. `collabBodyGuard` refuses an oversized body before
    // the limiter charges it and before the schema reads it. The document is
    // only found through the project in the path (core/collab/service.js).
    // A notebook also passes the notebooks gates (requireNotebookKindMw).
    'POST /:id/docs [requireProjectRoleMw,rateLimiter,validateRequest,requireNotebookKindMw]',
    'POST /:id/docs/:docId/sync [requireProjectRoleMw,rateLimiter,validateRequest,requireNotebookKindMw]',
    'POST /:id/docs/:docId/updates [requireProjectRoleMw,collabBodyGuard,rateLimiter,validateRequest,requireNotebookKindMw]',
    'POST /:id/docs/:docId/awareness [requireProjectRoleMw,rateLimiter,validateRequest,requireNotebookKindMw]',
    // What changed since your last visit (routes/projects/changes.js). All
    // viewer+: the seen marks are the reader's own, so a viewer writes them
    // too, behind one small per-member budget.
    'GET /:id/changes [requireProjectRoleMw,validateRequest]',
    'GET /:id/changes/log [requireProjectRoleMw,validateRequest]',
    'POST /:id/visit [requireProjectRoleMw,rateLimiter,validateRequest]',
    'POST /:id/seen [requireProjectRoleMw,rateLimiter,validateRequest]',
    'POST /:id/items/:type/:itemId/seen [requireProjectRoleMw,rateLimiter,validateRequest]',
    // Comment threads on notebooks and documents (routes/projects/comments.js).
    // Reading is viewer+, commenting editor+; editing or deleting ONE comment
    // is its author's (decided in the handler). Posting shares the comment
    // router's own lazily bound `rateLimitMiddleware`.
    'GET /:id/comments [requireProjectRoleMw,validateRequest]',
    'POST /:id/comments [requireProjectRoleMw,rateLimitMiddleware,validateRequest]',
    'GET /:id/comments/:threadId [requireProjectRoleMw,validateRequest]',
    'PATCH /:id/comments/:threadId [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/comments/:threadId [requireProjectRoleMw]',
    'POST /:id/comments/:threadId/resolve [requireProjectRoleMw]',
    'POST /:id/comments/:threadId/reopen [requireProjectRoleMw]',
    'POST /:id/comments/:threadId/replies [requireProjectRoleMw,rateLimitMiddleware,validateRequest]',
    'PATCH /:id/comments/:threadId/replies/:commentId [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/comments/:threadId/replies/:commentId [requireProjectRoleMw]',
    'POST /:id/comments/:threadId/replies/:commentId/feedback [requireProjectRoleMw,validateRequest]',
    // The one gentle compliance hint (routes/projects/complianceHints.js):
    // the gate is viewer+ (a viewer is answered "no hint"); an editor+
    // dismisses or snoozes it for themselves.
    'GET /:id/compliance-hints [requireProjectRoleMw]',
    'POST /:id/compliance-hints/:key/dismiss [requireProjectRoleMw,validateRequest]',
    'POST /:id/compliance-hints/:key/snooze [requireProjectRoleMw,validateRequest]',
];

test('projects route table and per-route role gates match the frozen baseline', () => {
    assert.deepStrictEqual(flatten(router.stack), EXPECTED);
});

test('the self-detach route is ordered ABOVE the /:id family', () => {
    const table = flatten(router.stack);
    const detach = table.findIndex(r => r.startsWith('DELETE /conversations/'));
    const firstId = table.findIndex(r => / \/:id\b/.test(r));
    assert.ok(detach >= 0, 'self-detach route is present');
    assert.ok(firstId >= 0, '/:id routes are present');
    assert.ok(detach < firstId,
        'DELETE /conversations/:convId must precede /:id or Express will never reach it');
});

test('every /:id route carries the shared role gate', () => {
    const ungated = flatten(router.stack).filter(r =>
        / \/:id/.test(r) && !r.includes('requireProjectRoleMw')
    );
    // The two deliberate exceptions, each authorized by who the caller is
    // rather than by their project role:
    //   - unsharing a chat is its owner's alone (it is re-encrypted under their
    //     key), member or not; `requireOwnThreadMw` 404s anybody else;
    //   - member removal doubles as self-leave (owner OR the member themselves).
    assert.deepStrictEqual(ungated, [
        'DELETE /:id/threads/:convId [requireOwnThreadMw,validateRequest]',
        'DELETE /:id/members/:memberId [rateLimiter]',
    ]);
});

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
    'GET /',
    'POST / [validateRequest]',
    // The Solutions overview. No role gate BY DESIGN — it answers with a row
    // per project the caller can already see, and listUserProjects IS the
    // authorisation. Like the self-detach route below, it is a one-segment path
    // and must precede /:id or Express hands "summary" to the role gate as a
    // project id.
    'GET /summary [validateRequest]',
    // Self-service detach — no role gate BY DESIGN, and it must precede /:id.
    'DELETE /conversations/:convId [validateRequest]',
    'GET /:id [requireProjectRoleMw]',
    'PUT /:id [requireProjectRoleMw,validateRequest]',
    'DELETE /:id [requireProjectRoleMw]',
    'POST /:id/share [rateLimiter,requireProjectRoleMw,validateRequest]',
    'DELETE /:id/share/:shareId [rateLimiter,requireProjectRoleMw]',
    'GET /:id/members [requireProjectRoleMw]',
    'PUT /:id/members/:memberId [rateLimiter,requireProjectRoleMw,validateRequest]',
    // Owner-removes / self-leave: the handler decides, so no role gate here.
    'DELETE /:id/members/:memberId [rateLimiter]',
    'GET /:id/activity [requireProjectRoleMw,validateRequest]',
    // Live feed + shared threads. The stream is viewer+ and re-checks the role
    // periodically while open; sharing is editor+ AND owner-of-the-conversation
    // (enforced in the handler, because sharing re-encrypts and only the owner
    // holds the key that opens the current ciphertext).
    'GET /:id/stream [requireProjectRoleMw,validateRequest]',
    'GET /:id/threads [requireProjectRoleMw,validateRequest]',
    'POST /:id/threads [requireProjectRoleMw,validateRequest]',
    'DELETE /:id/threads/:convId [requireProjectRoleMw,validateRequest]',
    'POST /:id/typing [requireProjectRoleMw,validateRequest]',
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
    'POST /:id/package/export [featureGate,requireProjectRoleMw,validateRequest,stampExport]',
    // Planning is separate from applying on purpose: "3 will be updated, 1 you
    // edited will be left alone" is a decision, and an upgrade that only tells
    // you afterwards is not offering one. Owner for both — an upgrade rewrites
    // other members' entities.
    'POST /:id/package/upgrade/plan [featureGate,requireProjectRoleMw,validateRequest]',
    'POST /:id/package/upgrade [featureGate,requireProjectRoleMw,validateRequest]',
    // De publicatiegeschiedenis: één rij per uitgave, met per entiteit wat er
    // in die versie veranderde. Eigenaar, en niet lager — wie dit leest leest
    // de inhoudsopgave van élke versie die er ooit is geweest, ook van
    // entiteiten die er nu niet meer in zitten. Dezelfde rol als exporteren.
    'GET /:id/package/releases [featureGate,requireProjectRoleMw]',
    // Hoe vaak deze Oplossing is geïnstalleerd: twee getallen, in de eigen
    // organisatie en elders op deze instantie. De ENIGE plek waar een
    // Blueprint-antwoord over de org-grens heen kijkt, en daarom op de
    // eigenaarsrol van het BRONPROJECT — wie hier binnenkomt is per definitie
    // iemand uit de organisatie die de Blueprint gemaakt heeft.
    'GET /:id/package/installs [featureGate,requireProjectRoleMw]',
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
    // The one deliberate exception: member removal doubles as self-leave, so the
    // handler authorizes (owner OR the member themselves) rather than the ladder.
    assert.deepStrictEqual(ungated, ['DELETE /:id/members/:memberId [rateLimiter]']);
});

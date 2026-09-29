'use strict';

/**
 * PUT /api/datatables/:id/sharing — the audience descriptor, driven through the
 * real route against a stubbed store.
 *
 * Behavioural, not the fs.readFileSync/regex shape routes/datatables.test.js
 * uses, because the property that matters here is a MAPPING and a regex cannot
 * see a mapping: audience word in, two columns out, and no third possibility.
 *
 * What it pins, and why each one is load-bearing:
 *
 *   - `audience:'groups'` with an empty (or all-invalid) list is a 400, never
 *     `is_published=true, shared_groups=[]`. That pair means the WHOLE
 *     ORGANISATION everywhere it is read (auth/audience.canSeePublished), so
 *     writing it in answer to "share with specific groups" is a live
 *     disclosure. The Studio used to send exactly that pair the moment someone
 *     picked the narrowest option on the screen.
 *   - a refused request leaves the row alone. A validation failure that has
 *     already half-written is worse than no validation.
 *   - READ and WRITE stay two axes: no audience ever sets write_mode, and
 *     write_mode never publishes. One field governing both would turn "share
 *     this with the company" into "let the company delete the rows".
 *
 * Run: node --test --test-force-exit routes/datatables.sharing.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// ── Per-test mutable state the stubs read ───────────────────────────────────

let USERS = {};        // id → the `users` row a fresh getUser returns
let GROUPS = [];       // the `groups` rows getAllGroups returns
let TABLE = null;      // the one `datatables` row under test
let WRITES = [];       // every setSharing patch that actually reached the store
let WARNINGS = [];

function resetState() {
    USERS = { 'u-owner': { id: 'u-owner', organizationId: 'org-a', orgRole: 'member', groups: [] } };
    GROUPS = [
        { id: 'g-sales', organizationId: 'org-a' },
        { id: 'g-support', organizationId: 'org-a' },
        { id: 'g-elsewhere', organizationId: 'org-b' },
    ];
    TABLE = {
        id: 'tbl_a', scope: { kind: 'org', id: 'org-a' }, scopeKind: 'org',
        scope_kind: 'org', scope_id: 'org-a',
        organizationId: 'org-a', organization_id: 'org-a',
        owner_user_id: 'u-owner', ownerUserId: 'u-owner',
        key: 'orders', name: 'Orders', description: 'the orders',
        is_published: false, isPublished: false, shared_groups: [], sharedGroups: [],
        write_mode: 'grants', writeMode: 'grants', row_scope: 'all', rowScope: 'all',
        rowCount: 3, retentionDays: null, projectId: null, updatedAt: null,
    };
    WRITES = [];
    WARNINGS = [];
}

mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => USERS[id] || null,
    getAllGroups: async () => GROUPS,
});

mock(path.join(SERVER, 'stores/datatableStore'), {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    getDatatable: async (id, scope) => (
        TABLE && TABLE.id === id && TABLE.scope_kind === scope.kind && TABLE.scope_id === scope.id ? TABLE : null),
    listGrants: async () => [],
    listGrantsForTables: async () => new Map(),
    listUsageCounts: async () => new Map(),
    setSharing: async (id, scope, patch) => {
        WRITES.push({ id, scope, patch });
        // Mirror the store's COALESCE: undefined leaves the column alone.
        if (patch.isPublished !== undefined) TABLE.isPublished = !!patch.isPublished;
        if (patch.sharedGroups !== undefined) TABLE.sharedGroups = patch.sharedGroups;
        if (patch.writeMode !== undefined) TABLE.writeMode = patch.writeMode;
        return TABLE;
    },
});
mock(path.join(SERVER, 'stores/datatableDbStore'), {
    applyMigration: async () => {},
    invalidate: () => {},
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
});

// The gate chain is routes/datatables.test.js's job, not this file's.
const pass = () => (req, res, next) => next();
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { requireBetaFeature: pass, userHasBetaFeature: async () => false });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: pass });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: pass });

// The REAL group validator — the requireNonEmpty option is half of what this
// file tests, so stubbing it away would leave the 400 untested.
const permissions = require(path.join(SERVER, 'auth/permissions'));
mock(path.join(SERVER, 'auth'), {
    requirePermission: pass,
    requireActiveOrgForMutations: pass,
    assertUserCanUseOrg: async () => true,
    validateSharedGroupsForOrg: permissions.validateSharedGroupsForOrg,
    resolveAudienceContext: async () => ({ orgIds: new Set(), userGroups: [] }),
    hasPermission: async () => true,
    Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
});

const datatablesRouter = require('./datatables');

// ── Harness (same shape as routes/datatables.principal.test.js) ─────────────

const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function routeStack(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack.map(l => l.handle);
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

function makeRes() {
    const res = { statusCode: 200, body: null, sent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.sent = true; return res; };
    return res;
}

/**
 * Every handler of the route in order — the grade gate included, and the
 * terminal error handler behind them.
 *
 * `next(err)` is not `next()`. A request schema refuses by handing the error
 * to the terminal handler (core/http/validate), so a harness that treated any
 * next() as "carry on" would run the handler anyway and read a 200 off a
 * request the server had already refused.
 */
async function runRoute(method, routePath, req) {
    const res = makeRes();
    for (const handle of routeStack(datatablesRouter, method, routePath)) {
        let advanced = false;
        let failed = null;
        await handle(req, res, (err) => { advanced = true; failed = err || null; });
        if (failed) { terminalErrorHandler(failed, req, res, () => {}); break; }
        if (res.sent || !advanced) break;
    }
    return res;
}

/** The owner, with the returning-user session shape: an id and nothing else. */
const share = (body) => ({
    session: { user: { id: 'u-owner' } },
    params: { id: 'tbl_a' },
    query: {},
    body,
});

const realWarn = console.warn;
console.warn = (...args) => { WARNINGS.push(args.join(' ')); };
process.on('exit', () => { console.warn = realWarn; });

// ── The mapping table ───────────────────────────────────────────────────────

test('audience:private unpublishes and clears the group list', async () => {
    resetState();
    TABLE.isPublished = true;
    TABLE.sharedGroups = ['g-sales'];

    const res = await runRoute('put', '/:id/sharing', share({ audience: 'private' }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(WRITES.length, 1);
    assert.strictEqual(WRITES[0].patch.isPublished, false);
    assert.deepStrictEqual(WRITES[0].patch.sharedGroups, []);
    assert.strictEqual(res.body.datatable.isPublished, false);
});

test('audience:organisation publishes with an EMPTY group list — that pair is what "everyone" means', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing', share({ audience: 'organisation' }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(WRITES[0].patch.isPublished, true);
    assert.deepStrictEqual(WRITES[0].patch.sharedGroups, []);
});

test('audience:organisation ignores any sharedGroups the caller also sent', async () => {
    resetState();
    // The two fields could contradict each other in the old body. They cannot
    // now: the word decides, and the list is simply not consulted.
    const res = await runRoute('put', '/:id/sharing',
        share({ audience: 'organisation', sharedGroups: ['g-sales'] }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(WRITES[0].patch.sharedGroups, []);
});

test('audience:groups publishes with exactly the validated groups', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing',
        share({ audience: 'groups', sharedGroups: ['g-sales', 'g-support'] }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(WRITES[0].patch.isPublished, true);
    assert.deepStrictEqual(WRITES[0].patch.sharedGroups, ['g-sales', 'g-support']);
});

// ── The refusals, and the row they must not have touched ────────────────────

test('audience:groups with an EMPTY list is a 400, not a silent org-wide publish', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing', share({ audience: 'groups', sharedGroups: [] }));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'groups_required');
    assert.strictEqual(WRITES.length, 0, 'a refused request must not have written anything');
    assert.strictEqual(TABLE.isPublished, false, 'the table is still private');
});

test('audience:groups with no list at all is the same 400', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing', share({ audience: 'groups' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'groups_required');
    assert.strictEqual(WRITES.length, 0);
});

test('audience:groups naming another organisation\'s group is refused whole', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing',
        share({ audience: 'groups', sharedGroups: ['g-sales', 'g-elsewhere'] }));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /g-elsewhere/);
    assert.strictEqual(WRITES.length, 0, 'not even the valid half may be applied');
    assert.strictEqual(TABLE.isPublished, false);
});

test('an unknown audience word is refused rather than guessed at', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing', share({ audience: 'public' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'bad_audience');
    assert.strictEqual(WRITES.length, 0);
});

test('a bad writeMode is refused before anything is written', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing',
        share({ audience: 'organisation', writeMode: 'everyone' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(WRITES.length, 0, 'the audience half must not land while the write half is rejected');
    assert.strictEqual(TABLE.isPublished, false);
});

// ── READ and WRITE are two axes ─────────────────────────────────────────────

test('an audience change never touches write_mode, and write_mode never publishes', async () => {
    resetState();

    await runRoute('put', '/:id/sharing', share({ audience: 'organisation' }));
    assert.strictEqual(WRITES[0].patch.writeMode, undefined,
        'publishing must not be what made the table org-WRITABLE');

    WRITES = [];
    await runRoute('put', '/:id/sharing', share({ writeMode: 'audience' }));
    assert.strictEqual(WRITES[0].patch.writeMode, 'audience');
    assert.strictEqual(WRITES[0].patch.isPublished, undefined,
        'opening writes must not decide who can read');
    assert.strictEqual(WRITES[0].patch.sharedGroups, undefined);
});

// ── The legacy body is REFUSED, not honoured ───────────────────────────────

test('the legacy {isPublished, sharedGroups} body is refused, and writes nothing', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing',
        share({ isPublished: true, sharedGroups: ['g-sales'] }));
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'stale_client');
    assert.strictEqual(WRITES.length, 0, 'a refused body must not reach the store');
});

test('the ambiguous legacy body — published with no groups — cannot publish org-wide', async () => {
    resetState();

    // THE disclosure this route was rewritten to remove. The old UI sent exactly
    // this when someone picked "specific groups" before ticking one, and
    // auth/audience.js reads an empty list on a published table as the WHOLE
    // organisation. A browser tab still running that bundle must get an error,
    // never a silent org-wide publish.
    const res = await runRoute('put', '/:id/sharing',
        share({ isPublished: true, sharedGroups: [] }));
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'stale_client');
    assert.strictEqual(WRITES.length, 0);
});

test('a legacy body cannot unpublish either — the shape is refused, not interpreted', async () => {
    resetState();

    // Not only the widening direction: honouring HALF the old shape would leave
    // two vocabularies alive on one route, which is how the ambiguity returns.
    const res = await runRoute('put', '/:id/sharing', share({ isPublished: false }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(WRITES.length, 0);
});

test('a body with neither an audience nor the legacy fields changes nothing', async () => {
    resetState();

    const res = await runRoute('put', '/:id/sharing', share({}));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(WRITES[0].patch.isPublished, undefined);
    assert.strictEqual(WRITES[0].patch.sharedGroups, undefined);
    assert.strictEqual(WRITES[0].patch.writeMode, undefined);
    assert.strictEqual(res.body.datatable.grade, 'owner', 'a writeMode-only patch is not a legacy body');
});

// ── The gate is still in front of all of it ─────────────────────────────────

test('someone who is not the owner never reaches the mapping', async () => {
    resetState();
    USERS['u-other'] = { id: 'u-other', organizationId: 'org-a', orgRole: 'member', groups: [] };
    // gradeForPrincipal reads the SNAKE column; published + no groups makes
    // this colleague a viewer, so the refusal is 403 rather than the 404 that
    // hides a table you hold no grade on at all.
    TABLE.is_published = true;
    TABLE.isPublished = true;

    const req = share({ audience: 'organisation' });
    req.session.user.id = 'u-other';
    const res = await runRoute('put', '/:id/sharing', req);
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(WRITES.length, 0);
});

// ── A personal table has no sharing at all ──────────────────────────────────

test('a PERSONAL table refuses every sharing descriptor, and writes nothing', async () => {
    // Not "publishing it does something narrower": a table the surface promised
    // belongs to one account must not have an audience at all. The refusal is
    // named so the Studio can replace the tab rather than print a sentence.
    resetState();
    TABLE.scope = { kind: 'user', id: 'u-owner' };
    TABLE.scopeKind = 'user';
    TABLE.scope_kind = 'user';
    TABLE.scope_id = 'u-owner';
    TABLE.organizationId = null;
    TABLE.organization_id = null;

    for (const body of [{ audience: 'organisation' }, { audience: 'groups', sharedGroups: ['g-sales'] },
        { audience: 'private' }, { writeMode: 'audience' }]) {
        const res = await runRoute('put', '/:id/sharing', share(body));
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
        assert.strictEqual(res.body.code, 'personal_table_not_shareable');
    }
    assert.deepStrictEqual(WRITES, [], 'a refusal that had already written is no refusal');
    assert.strictEqual(TABLE.isPublished, false);
});

test('a PERSONAL table refuses a grant too — there is nobody to grant it to', async () => {
    resetState();
    TABLE.scope = { kind: 'user', id: 'u-owner' };
    TABLE.scopeKind = 'user';
    TABLE.scope_kind = 'user';
    TABLE.scope_id = 'u-owner';
    TABLE.organizationId = null;
    TABLE.organization_id = null;

    const res = await runRoute('post', '/:id/grants',
        share({ granteeType: 'user', granteeId: 'u-other', grade: 'viewer' }));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'personal_table_not_shareable');
});

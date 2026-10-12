'use strict';

/**
 * One resolver, three call sites — driven end to end against a stubbed
 * `users` table.
 *
 * The bug these pin is not subtle once you see it: `req.session.user` carries
 * an `organizationId` in exactly two of the login shapes
 * auth/sessionShapes.contract.test.js freezes (the connector JWT, and the
 * auto-login straight after a password SIGNUP). Password login, OPAQUE, every
 * OAuth callback and the x-session-token bridge all build
 * `{id, displayName, role, avatar, avatarType, isAdmin}` and nothing else. So
 * every RETURNING member looked org-less, and three separate hand-rolled copies
 * of "which org is this?" each read that field:
 *
 *   - GET /api/datatables answered `{datatables: []}` — for members too;
 *   - the builder's datatable picker never even queried, inside a try/catch;
 *   - POST /api/datatables answered 400 `no_organisation`;
 *   - an automation save stamped organization_id NULL, so reconcileUsage's
 *     `WHERE EXISTS (… organization_id = $1)` INSERT matched nothing and the
 *     "used by" index stayed empty while the save returned 200.
 *
 * Every session below therefore carries ONLY `{id}` — the returning-user shape.
 * A test that put an organizationId on the session would pass against the code
 * that shipped the bug.
 *
 * Route handlers invoked directly (no supertest) — the same require.cache
 * Module mock + findHandler technique as routes/automation/catalog.test.js.
 *
 * Run: node --test --test-force-exit routes/datatables.principal.test.js
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

let USERS = {};              // id → the `users` row a fresh getUser returns
let GROUPS = [];             // the `groups` rows getAllGroups returns
let TABLES = {};             // organizationId → datatables rows
let PERSONAL = {};           // userId → that account's own datatables rows
let GRANTS = {};             // datatable id → datatable_grants rows
let CREATED = [];            // createDatatable payloads
let USAGE_CALLS = [];        // reconcileUsage(automationId, scope, entries)
let USAGE_WRITTEN = 0;       // what reconcileUsage claims it wrote
let AUTOMATIONS = {};
let CREATED_AUTOMATIONS = [];
let WARNINGS = [];

function resetState() {
    USERS = {};
    GROUPS = [];
    TABLES = {};
    PERSONAL = {};
    GRANTS = {};
    CREATED = [];
    USAGE_CALLS = [];
    USAGE_WRITTEN = 0;
    AUTOMATIONS = {};
    CREATED_AUTOMATIONS = [];
    WARNINGS = [];
}

// ── The only store that matters: `users`, read fresh ────────────────────────

mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => USERS[id] || null,
    getAllGroups: async () => GROUPS,
});

// The create path owns its transaction now — the `datatables` row, the org
// model and the CREATE TABLE have to land together — so the router requires
// db.js directly. Without this stub every create here 500s on a real Postgres
// connection attempt, and the resolver question the file is about never runs.
// routes/datatables.integration.test.js is where the transaction itself is
// checked, against a real database.
mock(path.join(SERVER, 'db.js'), {
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
});

const inScope = (scope) => (scope.kind === 'org' ? TABLES[scope.id] : PERSONAL[scope.id]) || [];

mock(path.join(SERVER, 'stores/datatableStore'), {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    listDatatablesForScope: async (scope) => inScope(scope),
    listGrantsForTables: async (ids) => new Map(ids.map(id => [id, GRANTS[id] || []])),
    listUsageCounts: async (ids) => new Map(ids.map(id => [id, 0])),
    listGrants: async (id) => GRANTS[id] || [],
    getDatatable: async (id, scope) => inScope(scope).find(t => t.id === id) || null,
    getModel: async () => ({ model: { tables: [] }, modelVersion: 1 }),
    getTableMeta: async () => null,
    createDatatable: async (payload) => {
        CREATED.push(payload);
        return { id: 'tbl_new', rowCount: 0, sharedGroups: [], ...payload };
    },
    reconcileUsage: async (automationId, scope, entries) => {
        USAGE_CALLS.push({ automationId, scope, entries });
        return USAGE_WRITTEN;
    },
});
mock(path.join(SERVER, 'stores/datatableDbStore'), {
    applyMigration: async () => {},
    invalidate: () => {},
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
});

// The gate chain is not what these tests are about — accessRegistry and
// routes/datatables.test.js already freeze it.
const pass = () => (req, res, next) => next();
mock(path.join(SERVER, 'auth'), {
    requirePermission: pass,
    requireActiveOrgForMutations: pass,
    assertUserCanUseOrg: async () => true,
    validateSharedGroupsForOrg: async () => [],
    resolveAudienceContext: async () => ({ orgIds: new Set(), userGroups: [] }),
    hasPermission: async () => true,
    Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), {
    requireBetaFeature: pass,
    userHasBetaFeature: async () => false,
});
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: pass });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: pass });

// ── What routes/automation/{catalog,crud}.js additionally pull in ───────────

mock(path.join(SERVER, 'stores/automationStore'), {
    getCallableStepsForUser: async () => [],
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    updateAutomation: async (id, updates) => { AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates }; return AUTOMATIONS[id]; },
    createAutomation: async (payload) => { CREATED_AUTOMATIONS.push(payload); return { id: 'auto_new', ...payload }; },
    ensureFormPage: async () => ({}),
});
mock(path.join(SERVER, 'stores/configStore'), { getConfig: async () => null });
mock(path.join(SERVER, 'stores/supportInboxStore'), { listInboxes: async () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/sideEffectMap'), { isSideEffect: () => false });
mock(path.join(SERVER, 'automation/outputSchemas'), {
    getOutputSchema: () => null,
    synthesizeDryRunOutput: () => ({}),
    producesList: () => false,
    iterableFieldsOf: () => [],
});
mock(path.join(SERVER, 'automation/deliverableEvents'), {
    deliverabilityForCatalog: () => ({}),
    getDeliverableEvents: () => [],
});
mock(path.join(SERVER, 'core/integrations/integrationToolMap'), { resolveIntegration: () => null });
mock(path.join(SERVER, 'core/integrations/integrationTools'), {
    getIntegrationTools: async () => ({ tools: [] }),
    getUserPermittedApps: async () => new Set(),
    listAvailableMcpServerIds: async () => [],
});
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => null,
    loadSession: async () => null,
    revokeSubscription: async () => {},
    dispatchEvent: async () => [],
});
mock(path.join(SERVER, 'automation/builderTools'), { buildTriggerOutputsCatalog: () => ({}) });
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ ok: true, warnings: [] }) });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/triggerColumns'), {
    triggerColumnsFromDefinition: () => ({ triggerType: 'manual', scheduleCron: null, scheduleTz: null }),
});
mock(path.join(SERVER, 'automation/approvalService'), { validateApprovalAssignees: async () => [] });
mock(path.join(SERVER, 'automation/portability'), {
    buildExport: () => ({}),
    sanitizeImport: () => ({ automation: null, errors: ['not used'] }),
    rekeyDefinition: (d) => ({ definition: d }),
    collectPinnedNodes: () => [],
});

const datatablesRouter = require('./datatables');
const catalogRouter = require('./automation/catalog');
const crudRouter = require('./automation/crud');

// ── Harness ─────────────────────────────────────────────────────────────────

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
 * Run every handler of one route in order, stopping at the first that answers.
 * The gate (requireDatatableGrade) is a route-level middleware, so a test that
 * only invoked the last handler would skip the very thing under test.
 */
/**
 * `next(err)` is not `next()`: a request schema refuses by handing the error
 * to the terminal handler, so it has to be behind this stack or a refused
 * request reads as a 200 from the handler that should never have run.
 */
async function runRoute(router, method, routePath, req) {
    const res = makeRes();
    for (const handle of routeStack(router, method, routePath)) {
        let advanced = false;
        let failed = null;
        await handle(req, res, (err) => { advanced = true; failed = err || null; });
        if (failed) { terminalErrorHandler(failed, req, res, () => {}); break; }
        if (res.sent || !advanced) break;
    }
    return res;
}

/** The RETURNING-user session: an id, and nothing else. */
const returning = (id) => ({ session: { user: { id } }, params: {}, query: {}, body: {} });

const table = (over = {}) => ({
    id: 'tbl_a', scope: { kind: 'org', id: 'org-a' }, scopeKind: 'org',
    scope_kind: 'org', scope_id: 'org-a',
    organizationId: 'org-a', organization_id: 'org-a',
    owner_user_id: 'u-other', ownerUserId: 'u-other',
    key: 'orders', name: 'Orders', description: 'the orders',
    is_published: true, isPublished: true, shared_groups: [], sharedGroups: [],
    write_mode: 'grants', writeMode: 'grants', row_scope: 'all', rowScope: 'all',
    rowCount: 3, retentionDays: null, projectId: null, updatedAt: null,
    ...over,
});

// Console noise from the crud warning path is an assertion target, not noise.
const realWarn = console.warn;
console.warn = (...args) => { WARNINGS.push(args.join(' ')); };
process.on('exit', () => { console.warn = realWarn; });

// ── GET /api/datatables ─────────────────────────────────────────────────────

test('a member whose session carries no organizationId still sees the org tables', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    TABLES['org-a'] = [table()];

    const res = await runRoute(datatablesRouter, 'get', '/', returning('u-member'));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.datatables.map(t => t.id), ['tbl_a'],
        'the org came off the users row, not off the session');
    assert.deepStrictEqual(res.body.scope, { kind: 'org', id: 'org-a', label: 'your organisation' });
});

test('an org-less account gets a PERSONAL scope, not a dead end', async () => {
    resetState();
    // The empty string, not null: createUser writes `organizationId || ''`.
    // This used to answer `{scope: null, reason: 'no_scope'}` — an account that
    // could never own a table here, which is what BFSF-412 was filed about.
    USERS['u-solo'] = { id: 'u-solo', organizationId: '', orgRole: '', groups: [] };
    PERSONAL['u-solo'] = [table({
        id: 'tbl_mine', scope: { kind: 'user', id: 'u-solo' }, scopeKind: 'user',
        scope_kind: 'user', scope_id: 'u-solo',
        organizationId: null, organization_id: null,
        owner_user_id: 'u-solo', ownerUserId: 'u-solo',
        is_published: false, isPublished: false,
    })];

    const res = await runRoute(datatablesRouter, 'get', '/', returning('u-solo'));
    assert.deepStrictEqual(res.body.scope, { kind: 'user', id: 'u-solo', label: 'this account' });
    assert.deepStrictEqual(res.body.datatables.map(t => [t.id, t.grade, t.scopeKind]),
        [['tbl_mine', 'owner', 'user']]);
});

test('a member sees the organisation\'s tables AND their own personal ones', async () => {
    resetState();
    // Listing only the "current" scope would hide a table someone made before
    // joining an organisation — their own rows, unreachable and un-erasable.
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    TABLES['org-a'] = [table()];
    PERSONAL['u-member'] = [table({
        id: 'tbl_mine', scope: { kind: 'user', id: 'u-member' }, scopeKind: 'user',
        scope_kind: 'user', scope_id: 'u-member',
        organizationId: null, organization_id: null,
        owner_user_id: 'u-member', ownerUserId: 'u-member',
        is_published: false, isPublished: false,
    })];

    const res = await runRoute(datatablesRouter, 'get', '/', returning('u-member'));
    assert.deepStrictEqual(res.body.datatables.map(t => t.id).sort(), ['tbl_a', 'tbl_mine']);
    assert.deepStrictEqual(res.body.scope, { kind: 'org', id: 'org-a', label: 'your organisation' },
        'a new table still defaults to the organisation for a member');
});

test('a member who reaches the org only through a group sees its tables', async () => {
    resetState();
    USERS['u-grouped'] = { id: 'u-grouped', organizationId: '', orgRole: '', groups: ['g-1'] };
    GROUPS = [{ id: 'g-0', organizationId: null }, { id: 'g-1', organizationId: 'org-b' }];
    TABLES['org-b'] = [table({ id: 'tbl_b', organizationId: 'org-b', organization_id: 'org-b' })];

    const res = await runRoute(datatablesRouter, 'get', '/', returning('u-grouped'));
    assert.deepStrictEqual(res.body.datatables.map(t => t.id), ['tbl_b']);
    assert.deepStrictEqual(res.body.scope, { kind: 'org', id: 'org-b', label: 'your organisation' });
});

// ── The per-table gate ──────────────────────────────────────────────────────

test('the grade gate reaches the table for a session with no org on it', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    TABLES['org-a'] = [table()];

    const req = { ...returning('u-member'), params: { id: 'tbl_a' } };
    const res = await runRoute(datatablesRouter, 'get', '/:id', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.datatable.grade, 'viewer');
});

test('a session claiming another org and org_admin is ignored — the DB decides', async () => {
    resetState();
    // The poisoned half of the same defect: orgRole off a session is a role the
    // user may have lost months ago, and rule 3 turns it into owner.
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    TABLES['org-a'] = [table()];

    const req = { ...returning('u-member'), params: { id: 'tbl_a' } };
    req.session.user.organizationId = 'org-evil';
    req.session.user.orgRole = 'org_admin';

    const res = await runRoute(datatablesRouter, 'get', '/:id', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.datatable.grade, 'viewer', 'a session-declared org_admin must not grant owner');
});

// ── POST /api/datatables ────────────────────────────────────────────────────

test('creating a table no longer 400s a member whose session omits the org', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };

    const req = returning('u-member');
    req.body = { name: 'Leads', key: 'leads', description: 'inbound leads' };
    const res = await runRoute(datatablesRouter, 'post', '/', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(CREATED.length, 1);
    assert.deepStrictEqual(CREATED[0].scope, { kind: 'org', id: 'org-a' });
    assert.strictEqual(CREATED[0].ownerUserId, 'u-member');
});

test('an account with no organisation creates a PERSONAL table instead of a 400', async () => {
    resetState();
    USERS['u-solo'] = { id: 'u-solo', organizationId: '', orgRole: '', groups: [] };

    const req = returning('u-solo');
    req.body = { name: 'Leads', key: 'leads', description: 'inbound leads' };
    const res = await runRoute(datatablesRouter, 'post', '/', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(CREATED[0].scope, { kind: 'user', id: 'u-solo' });
    assert.strictEqual(CREATED[0].ownerUserId, 'u-solo');
});

test('asking for an ORGANISATION table without one is still the honest 400', async () => {
    resetState();
    USERS['u-solo'] = { id: 'u-solo', organizationId: '', orgRole: '', groups: [] };

    const req = returning('u-solo');
    req.body = { scope: 'organisation', name: 'Leads', key: 'leads', description: 'inbound leads' };
    const res = await runRoute(datatablesRouter, 'post', '/', req);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'no_organisation');
    assert.strictEqual(CREATED.length, 0);
});

test('a member can ask for a personal table explicitly', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };

    const req = returning('u-member');
    req.body = { scope: 'personal', name: 'Notes', key: 'notes', description: 'my notes' };
    const res = await runRoute(datatablesRouter, 'post', '/', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(CREATED[0].scope, { kind: 'user', id: 'u-member' });
});

test('an unknown scope word is refused rather than silently defaulted', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };

    const req = returning('u-member');
    req.body = { scope: 'team', name: 'Leads', key: 'leads', description: 'x' };
    const res = await runRoute(datatablesRouter, 'post', '/', req);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'bad_scope');
    assert.strictEqual(CREATED.length, 0);
});

// ── The builder's datatable picker ──────────────────────────────────────────

test('the builder picker lists the org tables for a returning member', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    TABLES['org-a'] = [table()];

    const req = returning('u-member');
    req.session.isAdmin = false;
    const res = await runRoute(catalogRouter, 'get', '/catalog', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.datatables.map(t => t.id), ['tbl_a'],
        'the picker used to be empty AND silent — its try/catch swallowed a lookup that never ran');
    assert.strictEqual(res.body.datatables[0].canWrite, false);
});

// ── The automation save ────────────────────────────────────────────────────────

const withDatatableStep = {
    trigger: { kind: 'manual' },
    steps: [{ id: 's1', type: 'datatable', op: 'add_row', datatableId: 'tbl_a', values: { name: 'x' } }],
};

test('an automation save stamps the DB organisation on the usage index', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    AUTOMATIONS['auto_1'] = { id: 'auto_1', userId: 'u-member', isActive: false, definition: {} };
    USAGE_WRITTEN = 1;

    const req = { ...returning('u-member'), params: { id: 'auto_1' }, body: { definition: withDatatableStep } };
    const res = await runRoute(crudRouter, 'put', '/:id', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(USAGE_CALLS.length, 1);
    assert.deepStrictEqual(USAGE_CALLS[0].scope, { kind: 'org', id: 'org-a' },
        'this used to be null, so the INSERT\'s WHERE EXISTS matched nothing and the index stayed empty');
    assert.strictEqual(USAGE_CALLS[0].entries.length, 1);
});

test('a save whose datatable steps write NO usage rows says so', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    AUTOMATIONS['auto_1'] = { id: 'auto_1', userId: 'u-member', isActive: false, definition: {} };
    USAGE_WRITTEN = 0;   // the table is not in that org — a guarded INSERT no-op

    const req = { ...returning('u-member'), params: { id: 'auto_1' }, body: { definition: withDatatableStep } };
    const res = await runRoute(crudRouter, 'put', '/:id', req);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(WARNINGS.some(w => w.includes('no usage rows written')),
        'a silent no-op INSERT is what made every "used by" panel empty');
});

test('creating an automation stamps the organisation the DB says, not the session', async () => {
    resetState();
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };

    const req = returning('u-member');
    req.body = { title: 'Nightly', definition: { trigger: { kind: 'manual' }, steps: [] } };
    const res = await runRoute(crudRouter, 'post', '/', req);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(CREATED_AUTOMATIONS.length, 1);
    assert.strictEqual(CREATED_AUTOMATIONS[0].organizationId, 'org-a');
});

// ── The memo ────────────────────────────────────────────────────────────────

test('the principal is resolved once per request, not once per call site', async () => {
    resetState();
    let reads = 0;
    USERS['u-member'] = { id: 'u-member', organizationId: 'org-a', orgRole: 'member', groups: [] };
    TABLES['org-a'] = [table()];

    const userStore = require(path.join(SERVER, 'stores/userStore'));
    const real = userStore.getUser;
    userStore.getUser = async (id) => { reads += 1; return real(id); };
    try {
        // The gate resolves it, then the handler asks again.
        const req = { ...returning('u-member'), params: { id: 'tbl_a' } };
        await runRoute(datatablesRouter, 'get', '/:id', req);
        assert.ok(reads > 0, 'the resolver must read `users` at least once');
        const first = reads;
        await require(path.join(SERVER, 'auth/datatableAccess')).resolveDatatablePrincipal(req);
        assert.strictEqual(reads, first, 'a second resolve on the same request must be free');
    } finally {
        userStore.getUser = real;
    }
});

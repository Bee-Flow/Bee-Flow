/**
 * App Studio action-run bridge — security model + run semantics.
 *
 * Exercises the real Express router with stubbed stores/runner via the
 * require-cache trick (same as automation.ratelimit.test.js) and a stubbed
 * req/res dispatch harness — no HTTP listener, no DB. body-parser 2.x skips
 * stream reads when there's no content-length header, so preset req.body
 * objects flow through the full middleware chain untouched.
 *
 * Run: cd server && node --test routes/studioAppsRun.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Env knobs must be set before the router loads — read into module constants.
// A tiny sync-wait keeps the timeout→202 test fast; instantly-resolving runner
// mocks still win the race (microtask vs timer).
process.env.STUDIO_APP_ACTION_WAIT_MS = '60';

// ── Require-cache stubs (before the router loads) ──────────────────────────
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const apps = new Map();
const automations = new Map();
const runsById = new Map();
const stepsByRun = new Map();
const usageEntries = [];
const runnerCalls = [];
// Per-test override; default = instant success.
let runnerImpl = async () => ({ id: 'run-default', status: 'success', output: null, error: null });

// Faithful copy of the store's pure predicate (the real module eagerly
// connects to Postgres at require time, so it can't be loaded here).
function canReadStudioApp(app, userId, userGroupIds = [], userOrgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished) return false;
    if (!app.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(app.organizationId)) return false;
    const groups = Array.isArray(app.sharedGroups) ? app.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some(g => userGroupIds.includes(g));
}

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp,
    // The project-widened predicate, same shape as the real store's: consulted
    // only after the sync one says no, publication still required, membership
    // from projectRoles. Every fixture that sets no projectId gets the sync
    // answer, which is what the real store returns for project_id NULL.
    canReadStudioAppAsync: async (app, userId, groups = [], orgIds = []) => {
        if (canReadStudioApp(app, userId, groups, orgIds)) return true;
        if (!app || !app.projectId || !userId || !app.isPublished) return false;
        return !!projectRoles[`${userId}:${app.projectId}`];
    },
});

// `${userId}:${projectId}` → role. The Solution-membership stand-in.
const projectRoles = {};
stub('../stores/automationStore', {
    getAutomation: async (id) => automations.get(id) || null,
    getRun: async (id) => runsById.get(id) || null,
    getRunSteps: async (id) => stepsByRun.get(id) || [],
});
stub('../stores/usageStore', {
    logUsage: async (entry) => { usageEntries.push(entry); },
});
// requireAuth (auth/permissions) verifies the session user still exists.
stub('../stores/userStore', {
    getUser: async (id) => ({ id }),
});
stub('../auth/audience', {
    // The harness plants the audience on the request; the real resolver hits
    // the user store + org membership tables.
    resolveAudienceContext: async (req) => ({
        userId: req.session?.user?.id || null,
        orgIds: new Set(req._testOrgIds || []),
        userGroups: req._testGroups || [],
    }),
});
stub('../core/automationRunner', {
    executeAutomation: async (automation, opts) => {
        runnerCalls.push({ automation, opts });
        return runnerImpl(automation, opts);
    },
});

// ── /step endpoint collaborators ────────────────────────────────────────────
// The data model is opaque to the route (it just threads it to the executor);
// resolveViewerRole + executeDataStep are stubbed so the route's step
// resolution / kind enforcement / owner-run wiring is what's under test.
const DATA_MODEL = { modelVersion: 1, tables: [{ id: 'tbl_x', key: 'notes', fields: [], access: { default: 'app', roles: {}, rowFilters: {} } }] };
const stepCalls = [];
let stepResult = { ok: true, result: { id: 'rec_new' } };

stub('../stores/studioAppDataStore', {
    getDataModel: async (appId, ownerId) => ({ appId, ownerUserId: ownerId, model: DATA_MODEL, modelVersion: 1 }),
    getMemberRole: async () => null,
});
// Load-time dep of the real actionExecutor (via studioAppQuota) — never
// called here because executeDataStep is patched below.
stub('../stores/studioAppDbStore', {});
stub('../appStudio/rlsGateway', {
    // Owner → 'owner'; any other visible viewer → 'member'. Enough for the
    // route to build ctx.role and pass it to the executor.
    resolveViewerRole: async (app, viewerId) => (app.userId === viewerId ? 'owner' : 'member'),
});

// The REAL actionExecutor is loaded — the route imports its SHARED
// resolveInputs/deriveFinalOutput (Wave 2C dedup), so the input-mapping and
// output-derivation tests below exercise the single implementation. Only
// executeDataStep is patched, so the /step tests observe the route's wiring
// (step resolution, kind enforcement, owner-run) rather than the executor.
const actionExecutor = require('../appStudio/actionExecutor');
actionExecutor.executeDataStep = async (app, model, step, ctx) => {
    stepCalls.push({ app, model, step, ctx });
    return stepResult;
};

// Real module (dependency-free) — the route listens on it for the run id a
// 202 must carry, so the runner stub emits on it like the real runner does.
const runEventBus = require('../core/runEventBus');

const router = require('./studioAppsRun');

// ── Dispatch harness ────────────────────────────────────────────────────────
function dispatch({ method = 'POST', url, user = 'viewer-1', userOrgId = null, orgIds = [], groups = [], body, query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query,
            ip: '203.0.113.1',
            headers: {},
            session: user ? { isAuthenticated: true, user: { id: user, organizationId: userOrgId } } : null,
            _testOrgIds: orgIds,
            _testGroups: groups,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200,
            headers: {},
            body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            getHeader(k) { return this.headers[String(k).toLowerCase()]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const OWNER = 'owner-1';
const ORG = 'org-1';

function defWithActions(actions, screens) {
    return { schemaVersion: 1, meta: {}, theme: {}, homeScreenId: 's1', screens: screens || [], actions: actions || {} };
}

let seq = 0;
function makeApp({ published = true, actionsPub, actionsDraft, screensPub, sharedGroups = [], org = ORG, owner = OWNER } = {}) {
    const id = `app-${++seq}`;
    const app = {
        id,
        userId: owner,
        organizationId: org,
        name: 'Test app',
        isPublished: published,
        sharedGroups,
        definition: defWithActions(actionsDraft, screensPub),
        publishedDefinition: actionsPub === undefined ? null : defWithActions(actionsPub, screensPub),
    };
    apps.set(id, app);
    return app;
}

function makeAutomation(id, owner = OWNER) {
    const a = { id, userId: owner, isActive: true, title: `Automation ${id}` };
    automations.set(id, a);
    return a;
}

makeAutomation('auto-owner');
makeAutomation('auto-other', 'someone-else');
makeAutomation('auto-draft-only');

const RUN_ACTION = { kind: 'run_automation', automationId: 'auto-owner', inputMapping: null };

test.beforeEach(() => {
    runnerCalls.length = 0;
    usageEntries.length = 0;
    stepCalls.length = 0;
    stepResult = { ok: true, result: { id: 'rec_new' } };
    runnerImpl = async () => ({ id: 'run-default', status: 'success', output: null, error: null });
});

// ── Action resolution ───────────────────────────────────────────────────────

test('unknown actionId answers 404', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/nope/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(runnerCalls.length, 0);
});

test('non-run_automation action (navigate) answers 404', async () => {
    const app = makeApp({ actionsPub: { go: { kind: 'navigate', screenId: 's2' } } });
    const r = await dispatch({ url: `/${app.id}/actions/go/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(runnerCalls.length, 0);
});

// ── Visibility gate ─────────────────────────────────────────────────────────

test('unpublished app + non-owner answers 404 (no existence leak)', async () => {
    const app = makeApp({ published: false, actionsPub: { act1: RUN_ACTION }, actionsDraft: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(r.body.error, 'App not found');
    assert.strictEqual(runnerCalls.length, 0);
});

test('published app is runnable by an org viewer, but not from outside the org', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const ok = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(ok.statusCode, 200);
    const foreign = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'viewer-2', orgIds: ['other-org'], body: {} });
    assert.strictEqual(foreign.statusCode, 404);
});

test('group-scoped publish honours shared_groups', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION }, sharedGroups: ['g1'] });
    const inGroup = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'viewer-3', orgIds: [ORG], groups: ['g1'], body: {} });
    assert.strictEqual(inGroup.statusCode, 200);
    const outGroup = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'viewer-4', orgIds: [ORG], groups: ['g2'], body: {} });
    assert.strictEqual(outGroup.statusCode, 404);
});

test('a Solution member may run an app no org or group publish reaches (APPS-15)', async () => {
    // Published to g1 inside org-1; this viewer is in neither. Only the
    // Solution the app is filed into can carry them — and it carries them to
    // the run bridge, not merely to a tile.
    const app = makeApp({ actionsPub: { act1: RUN_ACTION }, sharedGroups: ['g1'] });
    app.projectId = 'p1';
    const before = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'proj-1', orgIds: ['other-org'], body: {} });
    assert.strictEqual(before.statusCode, 404);

    projectRoles['proj-1:p1'] = 'viewer';
    try {
        const after = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'proj-1', orgIds: ['other-org'], body: {} });
        assert.strictEqual(after.statusCode, 200, 'the gate the directory promises is the gate the bridge applies');

        // Unpublished again: there is no frozen copy to run, and membership
        // does not conjure one.
        app.isPublished = false;
        const gone = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'proj-1', orgIds: ['other-org'], body: {} });
        assert.strictEqual(gone.statusCode, 404);
    } finally {
        delete projectRoles['proj-1:p1'];
        app.isPublished = true;
    }
});

test('unauthenticated request answers 401', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, user: null, body: {} });
    assert.strictEqual(r.statusCode, 401);
});

// ── Draft vs published definition ───────────────────────────────────────────

test('non-owner ALWAYS runs the published definition, even with ?draft=1', async () => {
    // Published copy wires act1 → auto-owner; the working draft rewired it to
    // auto-draft-only. Viewers must get the frozen published wiring.
    const app = makeApp({
        actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-owner' } },
        actionsDraft: { act1: { kind: 'run_automation', automationId: 'auto-draft-only' } },
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run?draft=1`, orgIds: [ORG], body: {}, query: { draft: '1' } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(runnerCalls.length, 1);
    assert.strictEqual(runnerCalls[0].automation.id, 'auto-owner');
});

test('owner + ?draft=1 runs the working draft; owner without it runs the published copy', async () => {
    const app = makeApp({
        actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-owner' } },
        actionsDraft: { act1: { kind: 'run_automation', automationId: 'auto-draft-only' } },
    });
    const draft = await dispatch({ url: `/${app.id}/actions/act1/run?draft=1`, user: OWNER, body: {}, query: { draft: '1' } });
    assert.strictEqual(draft.statusCode, 200);
    assert.strictEqual(runnerCalls[0].automation.id, 'auto-draft-only');

    const pub = await dispatch({ url: `/${app.id}/actions/act1/run`, user: OWNER, body: {} });
    assert.strictEqual(pub.statusCode, 200);
    assert.strictEqual(runnerCalls[1].automation.id, 'auto-owner');
});

test('draft-only action on a published app is invisible to viewers (404)', async () => {
    const app = makeApp({
        actionsPub: {},
        actionsDraft: { act1: RUN_ACTION },
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 404);
});

// ── Automation ownership ────────────────────────────────────────────────────

test('automation owned by someone else answers 403 (post-wiring transfer)', async () => {
    const app = makeApp({ actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-other' } } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(runnerCalls.length, 0);
});

test('deleted automation answers 404', async () => {
    const app = makeApp({ actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-gone' } } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 404);
});

test('an automationId in the body is refused — wiring comes from the definition only', async () => {
    const app = makeApp({ actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-owner' } } });
    // The run body is closed (routes/studio/appRuntimeSchemas.js): the key is
    // refused by name before anything runs.
    await assert.rejects(dispatch({
        url: `/${app.id}/actions/act1/run`,
        orgIds: [ORG],
        body: { automationId: 'auto-other', formValues: {} },
    }), (err) => err.status === 400 && /"automationId"/.test(err.message));
    assert.strictEqual(runnerCalls.length, 0);

    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: { formValues: {} } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(runnerCalls.length, 1);
    assert.strictEqual(runnerCalls[0].automation.id, 'auto-owner');
});

// ── Role gate ───────────────────────────────────────────────────────────────
// Buttons carry `visibleToRoles`; the renderer merely HIDES a gated one, so the
// route proves the action is reachable for the viewer's role (stubbed gateway:
// owner → 'owner', any other viewer → 'member').

function screensWith(nodes, screenGate) {
    return [{
        id: 's1', name: 'Home',
        ...(screenGate ? { visibleToRoles: screenGate } : {}),
        sections: [{ id: 'sec1', children: nodes }],
    }];
}

const btn = (extra) => ({ id: 'cmp_btn', type: 'button', props: {}, onClick: 'act1', ...extra });

test('a viewer outside the button\'s visibleToRoles cannot run its action (403)', async () => {
    const app = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([btn({ visibleToRoles: ['admin'] })]),
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(runnerCalls.length, 0);
});

test('a viewer INSIDE the gate runs it; an ungated button is open to everyone', async () => {
    const gated = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([btn({ visibleToRoles: ['member'] })]),
    });
    const inRole = await dispatch({ url: `/${gated.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(inRole.statusCode, 200);

    const open = makeApp({ actionsPub: { act1: RUN_ACTION }, screensPub: screensWith([btn({ visibleToRoles: [] })]) });
    const r = await dispatch({ url: `/${open.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
});

test('a rowActions wiring counts as UI wiring for the role gate', async () => {
    // Before the walker learned props.rowActions, a grid-only action (a delete
    // button on an admin-only grid) was classified "programmatic" and waved
    // through for every role — leaving RLS as the only fence.
    const grid = (gate) => ({
        id: 'cmp_grid', type: 'data_grid',
        props: { rowActions: [{ label: 'Del', actionId: 'act1' }] },
        ...(gate ? { visibleToRoles: gate } : {}),
    });
    const gated = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([grid(['admin'])]),
    });
    const denied = await dispatch({ url: `/${gated.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(denied.statusCode, 403);

    const open = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([grid(null)]),
    });
    const ok = await dispatch({ url: `/${open.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(ok.statusCode, 200);
});

test('the app OWNER is never role-gated', async () => {
    const app = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([btn({ visibleToRoles: ['admin'] })]),
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, user: OWNER, body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(runnerCalls.length, 1);
});

test('a gate on the SCREEN or on an ancestor container hides the button too (403)', async () => {
    const byScreen = makeApp({ actionsPub: { act1: RUN_ACTION }, screensPub: screensWith([btn()], ['admin']) });
    const s = await dispatch({ url: `/${byScreen.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(s.statusCode, 403);

    const byContainer = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([{ id: 'cmp_box', type: 'container', props: {}, visibleToRoles: ['admin'], children: [btn()] }]),
    });
    const c = await dispatch({ url: `/${byContainer.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(c.statusCode, 403);
    assert.strictEqual(runnerCalls.length, 0);
});

test('ONE reachable wiring is enough, even when another is gated away', async () => {
    const app = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([
            btn({ id: 'cmp_admin', visibleToRoles: ['admin'] }),
            { id: 'cmp_grid', type: 'data_grid', props: {}, onRowClick: 'act1' },
        ]),
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
});

test('an action NO node wires stays runnable (programmatic actions are not gated)', async () => {
    const app = makeApp({
        actionsPub: { act1: RUN_ACTION },
        screensPub: screensWith([{ id: 'cmp_other', type: 'button', props: {}, onClick: 'act2', visibleToRoles: ['admin'] }]),
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(runnerCalls.length, 1);
});

// ── Input mapping ───────────────────────────────────────────────────────────

test('static + field mapping resolves server-side; unmapped keys dropped silently', async () => {
    const app = makeApp({
        actionsPub: {
            act1: {
                kind: 'run_automation',
                automationId: 'auto-owner',
                inputMapping: {
                    fixed: { kind: 'static', value: 42 },
                    email: { kind: 'field', name: 'email' },
                    missing: { kind: 'field', name: 'notSent' },
                },
            },
        },
    });
    const r = await dispatch({
        url: `/${app.id}/actions/act1/run`,
        orgIds: [ORG],
        body: { formValues: { email: 'a@b.nl', sneaky: 'dropped', nested: { x: 1 } } },
    });
    assert.strictEqual(r.statusCode, 200);
    const payload = runnerCalls[0].opts.triggerPayload;
    assert.deepStrictEqual(payload.inputs, { fixed: 42, email: 'a@b.nl' });
    assert.strictEqual(payload._viewerUserId, 'viewer-1');
    assert.strictEqual(payload._studioAppId, app.id);
    assert.strictEqual(payload._actionId, 'act1');
    assert.strictEqual(runnerCalls[0].opts.triggerKind, 'studio_app');
    assert.strictEqual(runnerCalls[0].opts.mode, 'live');
});

test('omitted mapping passes ALL primitive formValues; objects/arrays dropped silently', async () => {
    const app = makeApp({ actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-owner' } } });
    const r = await dispatch({
        url: `/${app.id}/actions/act1/run`,
        orgIds: [ORG],
        body: { formValues: { name: 'Tom', count: 3, ok: true, obj: { a: 1 }, arr: [1], nil: null } },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(runnerCalls[0].opts.triggerPayload.inputs, { name: 'Tom', count: 3, ok: true });
});

test('object value for a mapped field answers 400', async () => {
    const app = makeApp({
        actionsPub: {
            act1: {
                kind: 'run_automation',
                automationId: 'auto-owner',
                inputMapping: { email: { kind: 'field', name: 'email' } },
            },
        },
    });
    for (const bad of [{ nested: true }, ['a', 'b']]) {
        const r = await dispatch({
            url: `/${app.id}/actions/act1/run`,
            user: `viewer-badval-${Array.isArray(bad)}`,
            orgIds: [ORG],
            body: { formValues: { email: bad } },
        });
        assert.strictEqual(r.statusCode, 400);
        assert.match(r.body.error, /email/);
    }
    assert.strictEqual(runnerCalls.length, 0);
});

// ── app_trigger targets: the typed bridge ───────────────────────────────────

function makeAppTriggerAutomation(id, params, owner = OWNER) {
    const a = {
        id, userId: owner, isActive: true, title: `Automation ${id}`,
        definition: { trigger: { id: 'trg', kind: 'app_trigger', params }, steps: [], edges: [] },
    };
    automations.set(id, a);
    return a;
}

test('app_trigger target: validated inputs land FLAT (no `inputs` nesting) with the audit keys', async () => {
    makeAppTriggerAutomation('auto-at1', [
        { name: 'title', type: 'string', required: true },
        { name: 'amount', type: 'number' },
        { name: 'meta', type: 'object' },
    ]);
    const app = makeApp({
        actionsPub: {
            act1: {
                kind: 'run_automation',
                automationId: 'auto-at1',
                inputMapping: { meta: { kind: 'static', value: '{"src":"app"}' } },
            },
        },
    });
    const r = await dispatch({
        url: `/${app.id}/actions/act1/run`,
        orgIds: [ORG],
        body: { formValues: { title: 'Report', amount: '42', sneaky: 'never' } },
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const payload = runnerCalls[0].opts.triggerPayload;
    assert.ok(!('inputs' in payload), 'flat payload — no inputs nesting');
    assert.strictEqual(payload.title, 'Report', 'identity mapping by declared name');
    assert.strictEqual(payload.amount, 42, 'numeric string coerced');
    assert.deepStrictEqual(payload.meta, { src: 'app' }, 'static JSON parsed for object param');
    assert.ok(!('sneaky' in payload), 'undeclared fields never forwarded');
    assert.strictEqual(payload._viewerUserId, 'viewer-1');
    assert.strictEqual(payload._studioAppId, app.id);
    assert.strictEqual(payload._actionId, 'act1');
    assert.strictEqual(runnerCalls[0].opts.triggerKind, 'studio_app', 'runtime label unchanged');
});

test('app_trigger target: missing required inputs answer 400 listing all names', async () => {
    makeAppTriggerAutomation('auto-at2', [
        { name: 'a', type: 'string', required: true },
        { name: 'doc', type: 'file', required: true },
    ]);
    const app = makeApp({ actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-at2' } } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: { formValues: {} } });
    assert.strictEqual(r.statusCode, 400);
    assert.match(r.body.error, /Missing required inputs: a, doc/);
    assert.strictEqual(runnerCalls.length, 0);
});

test('app_trigger target: a type violation answers 400 naming the param', async () => {
    makeAppTriggerAutomation('auto-at3', [{ name: 'rows', type: 'array', required: true }]);
    const app = makeApp({ actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-at3' } } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: { formValues: { rows: 'not json' } } });
    assert.strictEqual(r.statusCode, 400);
    assert.match(r.body.error, /Input "rows" expects valid JSON/);
    assert.strictEqual(runnerCalls.length, 0);
});

test('non-app_trigger target with a definition still gets the legacy nested payload', async () => {
    automations.set('auto-manual-def', {
        id: 'auto-manual-def', userId: OWNER, isActive: true,
        definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] },
    });
    const app = makeApp({ actionsPub: { act1: { kind: 'run_automation', automationId: 'auto-manual-def' } } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: { formValues: { name: 'Tom', obj: { a: 1 } } } });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(runnerCalls[0].opts.triggerPayload, {
        inputs: { name: 'Tom' },
        _viewerUserId: 'viewer-1',
        _studioAppId: app.id,
        _actionId: 'act1',
    }, 'byte-identical legacy payload');
});

// ── Run semantics ───────────────────────────────────────────────────────────

test('completed run answers 200 with final output only (no step internals)', async () => {
    runnerImpl = async () => ({ id: 'run-9', status: 'success', output: { total: 7 }, error: null, steps: ['SECRET'] });
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body, { runId: 'run-9', status: 'success', output: { total: 7 }, error: null });
    assert.ok(!('steps' in r.body));
});

test('output falls back to the last top-level step when the run row has no output', async () => {
    // The real run ROW has no output column (executeAutomation returns the
    // persisted row), so the bridge derives it from the terminal top-level
    // step. Child rows (parentStepId set) and the trigger are skipped.
    runnerImpl = async () => ({ id: 'run-d', status: 'success', error: null });
    stepsByRun.set('run-d', [
        { stepId: 'trig', stepType: 'trigger', parentStepId: null, output: { ignore: true } },
        { stepId: 's1', stepType: 'integration_action', parentStepId: null, output: { rows: [1, 2] } },
        { stepId: 's1.child', stepType: 'integration_action', parentStepId: 's1', output: { child: true } },
        { stepId: 's2', stepType: 'integration_action', parentStepId: null, output: { rows: [{ name: 'A' }], count: 1 } },
    ]);
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body.output, { rows: [{ name: 'A' }], count: 1 });
    assert.strictEqual(r.body.status, 'success');
});

test('an answer too large to keep says so (_outputTooLarge) instead of passing as "no output"', async () => {
    // Over the 256 KB row cap AND over the full-copy limit: the row holds only
    // the truncation sentinel, with no kept copy to swap in. deriveRunOutcome
    // reports that as outputTooLarge; the app must hear it, or a list bound
    // to the answer is just empty with nothing saying why.
    const { truncatePayload } = require('../automation/payloadTruncation');
    const big = truncatePayload({ value: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, body: 'x'.repeat(900) })) });
    assert.strictEqual(big.truncated, true, 'the fixture is over the cap');
    runnerImpl = async () => ({ id: 'run-big', status: 'success', error: null });
    stepsByRun.set('run-big', [{ runId: 'run-big', stepId: 's1', stepType: 'integration_action', parentStepId: null, attempts: 1, output: big.value }]);
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.output, null, 'never the sentinel as if it were data');
    assert.strictEqual(r.body._outputTooLarge, true);

    // A run whose answer fit carries no such field: the body stays byte-identical.
    runnerImpl = async () => ({ id: 'run-small', status: 'success', error: null });
    stepsByRun.set('run-small', [{ runId: 'run-small', stepId: 's1', stepType: 'integration_action', parentStepId: null, output: { ok: 1 } }]);
    const small = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.ok(!('_outputTooLarge' in small.body));
});

test('output is null for a failed run (no step derivation)', async () => {
    runnerImpl = async () => ({ id: 'run-f', status: 'error', error: 'boom' });
    stepsByRun.set('run-f', [{ stepId: 's1', stepType: 'integration_action', parentStepId: null, output: { partial: true } }]);
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.output, null);
    assert.strictEqual(r.body.error, 'boom');
});

test('a run that beats the sync-wait cap leaves no guard timer armed', async () => {
    // The cap is a timer raced against the run. Left armed after the answer,
    // it held the request's closure for the rest of the wait (a minute in
    // production) after every run that finished in time.
    const armedTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    runnerImpl = async () => ({ id: 'run-t', status: 'success', output: null, error: null });
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const before = armedTimers();
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(armedTimers(), before, 'the guard timer is cleared once the run wins the race');
});

test('sync-wait timeout answers 202 pending; no started run is known → runId null', async () => {
    runnerImpl = () => new Promise(() => {}); // never resolves, never emits
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 202);
    assert.deepStrictEqual(r.body, { runId: null, status: 'pending' });
});

test('sync-wait timeout answers 202 with the REAL run id, and that id polls', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    runsById.set('run-live', {
        id: 'run-live', userId: OWNER, status: 'running', output: null, error: null,
        triggerPayload: { _studioAppId: app.id, _viewerUserId: 'viewer-1', _actionId: 'act1' },
    });
    // The runner emits run.started as soon as the row exists — long before
    // executeAutomation resolves.
    runnerImpl = (automation) => new Promise(() => {
        runEventBus.emitRunEvent('run.started', { runId: 'run-live', automationId: automation.id, userId: OWNER });
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 202);
    assert.deepStrictEqual(r.body, { runId: 'run-live', status: 'pending' });

    const poll = await dispatch({ method: 'GET', url: `/${app.id}/actions/runs/run-live`, orgIds: [ORG] });
    assert.strictEqual(poll.statusCode, 200, 'the 202 id is pollable');
    assert.strictEqual(poll.body.status, 'running');
});

test('a concurrent run of the same automation by ANOTHER viewer is never handed over', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    runsById.set('run-theirs', {
        id: 'run-theirs', userId: OWNER, status: 'running', output: null, error: null,
        triggerPayload: { _studioAppId: app.id, _viewerUserId: 'someone-else', _actionId: 'act1' },
    });
    runnerImpl = (automation) => new Promise(() => {
        runEventBus.emitRunEvent('run.started', { runId: 'run-theirs', automationId: automation.id, userId: OWNER });
    });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 202);
    assert.strictEqual(r.body.runId, null, 'audit keys must match this viewer + app + action');
});

test('markRunning concurrency skip is surfaced as status:"skipped"', async () => {
    runnerImpl = async () => ({
        id: 'run-skip',
        status: 'cancelled',
        error: 'Skipped: automation already running',
        summary: 'Skipped — this automation was already running.',
        output: null,
    });
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.status, 'skipped');
    assert.match(r.body.message, /already running/i);
});

test('usage is logged under the OWNER with source studio_app_action', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/run`, orgIds: [ORG], body: {} });
    assert.strictEqual(r.statusCode, 200);
    // logUsage fires on run settle (fire-and-forget) — allow the microtask.
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(usageEntries.length, 1);
    const entry = usageEntries[0];
    assert.strictEqual(entry.user_id, OWNER, 'usage attributed to the app owner, not the viewer');
    assert.strictEqual(entry.organization_id, ORG);
    assert.strictEqual(entry.source, 'studio_app_action');
    assert.strictEqual(entry.agent_id, app.id);
    assert.strictEqual(entry.agent_type, 'studio_app');
});

// ── Body cap ────────────────────────────────────────────────────────────────

test('parsed body above 64KB answers 413', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({
        url: `/${app.id}/actions/act1/run`,
        orgIds: [ORG],
        body: { formValues: { big: 'x'.repeat(70 * 1024) } },
    });
    assert.strictEqual(r.statusCode, 413);
    assert.strictEqual(runnerCalls.length, 0);
});

// ── Run polling ─────────────────────────────────────────────────────────────

test('poll: run belonging to the app owner is returned without steps', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    runsById.set('run-1', { id: 'run-1', userId: OWNER, status: 'success', output: { n: 1 }, error: null, steps: ['SECRET'], triggerPayload: { _studioAppId: app.id } });
    const r = await dispatch({ method: 'GET', url: `/${app.id}/actions/runs/run-1`, orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body, { runId: 'run-1', status: 'success', output: { n: 1 }, error: null });
});

test('poll: a foreign run (not the app owner\'s) answers 403', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    runsById.set('run-2', { id: 'run-2', userId: 'someone-else', status: 'success', output: null, error: null, triggerPayload: { _studioAppId: app.id } });
    const r = await dispatch({ method: 'GET', url: `/${app.id}/actions/runs/run-2`, orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 403);
});

test('poll: an owner run started by a DIFFERENT app answers 403', async () => {
    // Defense-in-depth: even the owner's own runs are only pollable through
    // the app that started them (the bridge stamps _studioAppId).
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    runsById.set('run-x', { id: 'run-x', userId: OWNER, status: 'success', output: { n: 9 }, error: null, triggerPayload: { _studioAppId: 'some-other-app' } });
    const r = await dispatch({ method: 'GET', url: `/${app.id}/actions/runs/run-x`, orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 403);
});

test('poll: missing run answers 404; non-visible app answers 404 before the run is looked at', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const missing = await dispatch({ method: 'GET', url: `/${app.id}/actions/runs/run-nope`, orgIds: [ORG] });
    assert.strictEqual(missing.statusCode, 404);

    const hidden = makeApp({ published: false, actionsPub: { act1: RUN_ACTION } });
    runsById.set('run-3', { id: 'run-3', userId: OWNER, status: 'success', output: null, error: null });
    const r = await dispatch({ method: 'GET', url: `/${hidden.id}/actions/runs/run-3`, orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(r.body.error, 'App not found');
});

// ── Rate limiting ───────────────────────────────────────────────────────────

test('actionRunLimiter is registered on the run route, after auth and before body parsing', () => {
    const layer = router.stack.find(l => l.route?.path === '/:id/actions/:actionId/run' && l.route.methods.post);
    assert.ok(layer, 'POST /:id/actions/:actionId/run registered');
    const names = layer.route.stack.map(l => l.name);
    assert.strictEqual(names[0], 'requireAuth');
    assert.strictEqual(names[1], 'rateLimitMiddleware', `limiter right after auth (got ${names.join(',')})`);
    assert.strictEqual(names[2], 'jsonParser', 'limiter precedes body parsing');
});

test('11th run in a minute for the same user+app is throttled; other users/apps unaffected', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const other = makeApp({ actionsPub: { act1: RUN_ACTION } });
    let last = null;
    for (let i = 0; i < 11; i++) {
        last = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'flooder', orgIds: [ORG], body: {} });
    }
    assert.strictEqual(last.statusCode, 429, 'the 11th request in the window is throttled');
    assert.ok(parseInt(last.headers['retry-after'], 10) >= 1, 'Retry-After header set');
    // Same user, different app → its own bucket.
    const otherApp = await dispatch({ url: `/${other.id}/actions/act1/run`, user: 'flooder', orgIds: [ORG], body: {} });
    assert.strictEqual(otherApp.statusCode, 200);
    // Different user, same app → its own bucket.
    const otherUser = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'calm-viewer', orgIds: [ORG], body: {} });
    assert.strictEqual(otherUser.statusCode, 200);
});

// ── POST /:id/actions/:actionId/step ─────────────────────────────────────────
//
// A v2 action sequence. Pre-order flatten:
//   0 toast(client)  1 create_record(server)  2 condition(client)
//   3 update_record(server, nested in `then`)
const SEQ_ACTION = {
    kind: 'sequence',
    steps: [
        { kind: 'toast', message: 'hi' },
        { kind: 'create_record', tableId: 'tbl_x', values: { title: { kind: 'field', name: 'title' } } },
        {
            kind: 'condition', expr: 'true',
            then: [{ kind: 'update_record', tableId: 'tbl_x', recordId: { kind: 'static', value: 'r' }, values: {} }],
            else: [],
        },
    ],
};

test('step: a server-kind step (create_record) executes acts-as-owner and returns its result', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({
        url: `/${app.id}/actions/seq/step`,
        orgIds: [ORG],
        body: { stepIndex: 1, formValues: { title: 'Hello' }, vars: {} },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body, { ok: true, result: { id: 'rec_new' } });
    assert.strictEqual(stepCalls.length, 1);
    const call = stepCalls[0];
    assert.strictEqual(call.app.userId, OWNER, 'executor runs against the app owner');
    assert.strictEqual(call.step.kind, 'create_record', 'the step is resolved from the DEFINITION by index');
    assert.strictEqual(call.ctx.viewerId, 'viewer-1', 'the viewer identity rides in ctx');
    assert.strictEqual(call.ctx.role, 'member', 'role resolved via the RLS gateway');
    assert.strictEqual(call.ctx.orgId, ORG);
    assert.deepStrictEqual(call.ctx.formValues, { title: 'Hello' });
});

test('step: a nested server step (inside a condition branch) resolves by its pre-order index', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({
        url: `/${app.id}/actions/seq/step`,
        orgIds: [ORG],
        body: { stepIndex: 3, formValues: {}, vars: {} },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(stepCalls.length, 1);
    assert.strictEqual(stepCalls[0].step.kind, 'update_record');
});

test('step: a CLIENT-only step index is rejected (400), executor never called', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    for (const idx of [0, 2]) { // toast, condition
        const r = await dispatch({
            url: `/${app.id}/actions/seq/step`,
            user: `viewer-client-${idx}`,
            orgIds: [ORG],
            body: { stepIndex: idx },
        });
        assert.strictEqual(r.statusCode, 400, `client step index ${idx} → 400`);
        assert.match(r.body.error, /does not run on the server/i);
    }
    assert.strictEqual(stepCalls.length, 0);
});

test('step: an out-of-range step index answers 404; a missing or negative one is refused', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, user: 'viewer-oob-9', orgIds: [ORG], body: { stepIndex: 9 } });
    assert.strictEqual(r.statusCode, 404);
    // Not a position at all: the step schema refuses it before the app is read.
    for (const body of [{ stepIndex: -1 }, {}]) {
        await assert.rejects(dispatch({ url: `/${app.id}/actions/seq/step`, user: `viewer-oob-${body.stepIndex}`, orgIds: [ORG], body }),
            (err) => err.status === 400 && /stepIndex/.test(err.message));
    }
    assert.strictEqual(stepCalls.length, 0);
});

test('step: a bare v1 run_automation action is an implicit 1-step sequence (index 0)', async () => {
    const app = makeApp({ actionsPub: { act1: RUN_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/act1/step`, orgIds: [ORG], body: { stepIndex: 0 } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(stepCalls.length, 1);
    assert.strictEqual(stepCalls[0].step.kind, 'run_automation');
});

/**
 * `create_record` became a top-level ACTION kind (P2), not just a sequence
 * step, so a button can be wired straight to "add a row". No new server path
 * was needed — a bare action normalizes to a 1-step sequence — but "no new
 * path was needed" is a claim, and this is the test that checks it: the step
 * has to actually reach the executor, with the tableId and the column values
 * the author wrote.
 */
test('step: a bare v1 create_record action reaches the executor with its values', async () => {
    const action = {
        kind: 'create_record',
        tableId: 'tbl_x',
        values: { title: { kind: 'field', name: 'title' } },
    };
    const app = makeApp({ actionsPub: { add: action } });
    const r = await dispatch({ url: `/${app.id}/actions/add/step`, orgIds: [ORG], body: { stepIndex: 0 } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(stepCalls.length, 1);
    assert.strictEqual(stepCalls[0].step.kind, 'create_record');
    assert.strictEqual(stepCalls[0].step.tableId, 'tbl_x');
    // The column map is the half that used to disappear on save; it must also
    // survive the trip to the executor.
    assert.deepEqual(stepCalls[0].step.values, { title: { kind: 'field', name: 'title' } });
});

test('step: a bare v1 CLIENT action (navigate) at index 0 is rejected (400)', async () => {
    const app = makeApp({ actionsPub: { go: { kind: 'navigate', screenId: 's2' } } });
    const r = await dispatch({ url: `/${app.id}/actions/go/step`, orgIds: [ORG], body: { stepIndex: 0 } });
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(stepCalls.length, 0);
});

test('step: unknown actionId answers 404', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/missing/step`, orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(stepCalls.length, 0);
});

test('step: an invisible app answers 404 before any step work (no existence leak)', async () => {
    const app = makeApp({ published: false, actionsPub: { seq: SEQ_ACTION }, actionsDraft: { seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, user: 'viewer-x', orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(r.body.error, 'App not found');
    assert.strictEqual(stepCalls.length, 0);
});

test('step: non-owner ALWAYS runs the published definition, even with ?draft=1', async () => {
    // Published wires index 1 → create_record on tbl_x; the draft rewired the
    // sequence so index 1 is a delete_record. A viewer must get the published one.
    const app = makeApp({
        actionsPub: { seq: SEQ_ACTION },
        actionsDraft: { seq: { kind: 'sequence', steps: [
            { kind: 'toast', message: 'hi' },
            { kind: 'delete_record', tableId: 'tbl_x', recordId: { kind: 'static', value: 'r' } },
        ] } },
    });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step?draft=1`, orgIds: [ORG], body: { stepIndex: 1 }, query: { draft: '1' } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(stepCalls[0].step.kind, 'create_record', 'frozen published wiring, not the draft');
});

test('step: owner + ?draft=1 resolves the working draft', async () => {
    const app = makeApp({
        actionsPub: { seq: SEQ_ACTION },
        actionsDraft: { seq: { kind: 'sequence', steps: [
            { kind: 'toast', message: 'hi' },
            { kind: 'delete_record', tableId: 'tbl_x', recordId: { kind: 'static', value: 'r' } },
        ] } },
    });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step?draft=1`, user: OWNER, body: { stepIndex: 1 }, query: { draft: '1' } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(stepCalls[0].step.kind, 'delete_record');
    assert.strictEqual(stepCalls[0].ctx.role, 'owner');
});

test('step: a handled failure comes back as { ok:false }', async () => {
    stepResult = { ok: false, error: 'Record not found' };
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.error, 'Record not found');
});

test('step: form values above 64KB answer 413, executor never called', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({
        url: `/${app.id}/actions/seq/step`,
        orgIds: [ORG],
        body: { stepIndex: 1, formValues: { big: 'x'.repeat(70 * 1024) } },
    });
    assert.strictEqual(r.statusCode, 413);
    assert.strictEqual(stepCalls.length, 0);
});

test('step: usage is logged under the OWNER', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(usageEntries.length, 1);
    assert.strictEqual(usageEntries[0].user_id, OWNER);
    assert.strictEqual(usageEntries[0].source, 'studio_app_action');
});

test('step: the executor gets the FULL viewer row filters read (id + role + org)', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, userOrgId: ORG, orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(stepCalls[0].ctx.viewer, { id: 'viewer-1', role: 'member', organizationId: ORG });
});

test('step: an automation step consumes the ACTION-RUN budget (no 6x bypass via /step)', async () => {
    // Index 0 of the bare v1 action IS the run_automation step.
    const app = makeApp({ actionsPub: { act1: RUN_ACTION, seq: SEQ_ACTION } });
    let last = null;
    for (let i = 0; i < 11; i++) {
        last = await dispatch({ url: `/${app.id}/actions/act1/step`, user: 'step-flooder', orgIds: [ORG], body: { stepIndex: 0 } });
    }
    assert.strictEqual(last.statusCode, 429, 'the 11th automation step in the window is throttled');
    assert.strictEqual(stepCalls.length, 10);
    // One shared bucket with /run — the budget is spent, not doubled.
    const viaRun = await dispatch({ url: `/${app.id}/actions/act1/run`, user: 'step-flooder', orgIds: [ORG], body: {} });
    assert.strictEqual(viaRun.statusCode, 429);
    // A cheap record step keeps its own looser bucket.
    const cheap = await dispatch({ url: `/${app.id}/actions/seq/step`, user: 'step-flooder', orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(cheap.statusCode, 200);
});

test('step: unauthenticated request answers 401', async () => {
    const app = makeApp({ actionsPub: { seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, user: null, body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 401);
});

// ── Role gate on /step ──────────────────────────────────────────────────────
// /run had one; /step had none. Every action in a v2 template is a sequence, so
// a whole app could hide a button from a role and then happily accept that
// role's POST of its actionId.

const rlsGatewayStub = require('../appStudio/rlsGateway');
const realResolveViewerRole = rlsGatewayStub.resolveViewerRole;

const HEAVY_SEQ = {
    kind: 'sequence',
    steps: [{ kind: 'ai_generate', prompt: 'draft a reply', resultVar: 'draft' }],
};

test('step: a viewer outside the button\'s visibleToRoles gets 403, executor never called', async () => {
    const app = makeApp({
        actionsPub: { seq: SEQ_ACTION },
        screensPub: screensWith([{ id: 'cmp_b', type: 'button', props: {}, onClick: 'seq', visibleToRoles: ['admin'] }]),
    });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(stepCalls.length, 0);
});

test('step: the owner is never gated by their own visibleToRoles', async () => {
    const app = makeApp({
        actionsPub: { seq: SEQ_ACTION },
        screensPub: screensWith([{ id: 'cmp_b', type: 'button', props: {}, onClick: 'seq', visibleToRoles: ['admin'] }]),
    });
    const r = await dispatch({ url: `/${app.id}/actions/seq/step`, user: OWNER, orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(r.statusCode, 200);
});

test('step: a heavy step is refused for a viewer with no role at all', async (t) => {
    // ai_*/send_email/kb_query touch no table, so RLS never sees them — but they
    // spend the OWNER's model quota and mail allowance.
    rlsGatewayStub.resolveViewerRole = async (app, viewerId) => (app.userId === viewerId ? 'owner' : null);
    t.after(() => { rlsGatewayStub.resolveViewerRole = realResolveViewerRole; });

    const app = makeApp({ actionsPub: { heavy: HEAVY_SEQ, seq: SEQ_ACTION } });
    const r = await dispatch({ url: `/${app.id}/actions/heavy/step`, orgIds: [ORG], body: { stepIndex: 0 } });
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(stepCalls.length, 0);

    // A cheap data step still goes through: RLS is the authority there, and it
    // will refuse a roleless viewer on its own terms rather than pre-emptively.
    const cheap = await dispatch({ url: `/${app.id}/actions/seq/step`, orgIds: [ORG], body: { stepIndex: 1 } });
    assert.strictEqual(cheap.statusCode, 200);
});

test('step: the 403 lands BEFORE the heavy-step budget is charged', async () => {
    // A refusal that has already spent someone's daily allowance is a bug of
    // its own: eleven denied clicks must not lock the app for the whole team.
    const app = makeApp({
        actionsPub: { heavy: HEAVY_SEQ },
        screensPub: screensWith([{ id: 'cmp_b', type: 'button', props: {}, onClick: 'heavy', visibleToRoles: ['admin'] }]),
    });
    for (let i = 0; i < 11; i++) {
        const r = await dispatch({ url: `/${app.id}/actions/heavy/step`, user: 'budget-probe', orgIds: [ORG], body: { stepIndex: 0 } });
        assert.strictEqual(r.statusCode, 403, `attempt ${i + 1} must be a role refusal, not a 429`);
    }
});

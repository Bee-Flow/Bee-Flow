// @typecheck
'use strict';

/**
 * P4 part D — the OWNERSHIP GATE on "New from this button", as WIRING.
 *
 * The pure rule lives in appStudio/appRefLookup.appRefOwnerVerdict and has its own tests
 * there. What those do not cover is the thread between them: the route that LOADS the app row and applies the verdict — including the question of which owner ends up in the column `automations.user_id`.
 *
 * Why that matters: an automation created from an app button is run BY THAT BUTTON AS THE APP OWNER (automationBridge refuses when the owners differ). If the route silently puts it under the clicker, the button is
 * broken from the first click; if it puts it under the app owner while someone else clicks, a stranger's automation will run later with the owner's rights. Hence: only proceed if those two are the same person, and "I could not check it" is a refusal, not a guess.
 *
 * Only the database underneath is a double; `validateDefinition`,
 * `appTriggerRef` and `appRefOwnerVerdict` are the real ones.
 *
 * Run: cd server && node --test --test-reporter=tap routes/automation/crud.appRefOwner.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');
const { mockModule: mock } = require('../../testUtils/moduleMock');

let CREATED = [];
let APPS = {};
let appLookups = [];
let appLookupThrows = false;

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async () => null,
    createAutomation: async (row) => { const a = { id: `aut_${CREATED.length + 1}`, ...row }; CREATED.push(a); return a; },
    ensureFormPage: async () => {},
});
mock(path.join(SERVER, 'stores/studioAppStore'), {
    getStudioApp: async (id) => {
        appLookups.push(id);
        if (appLookupThrows) throw new Error('database is down');
        return APPS[id] || null;
    },
});
mock(path.join(SERVER, 'core/scheduling/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => null, loadSession: async () => null, revokeSubscription: async () => {},
    fetchLatestGmailMatch: async () => null, dispatchEvent: async () => [],
});
mock(path.join(SERVER, 'automation/triggerBus/dispatch'), { dispatchEvent: async () => [], dispatchToSubscription: () => [] });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
mock(path.join(SERVER, 'core/kb/automationKbCheck'), { kbStepFindings: async () => [] });
mock(path.join(SERVER, 'core/kb/kbSourceSync'), { syncKbSources: async () => {} });
mock(path.join(SERVER, 'automation/datatableUsageSync'), { syncDatatableUsage: async () => {}, purgeDatatableUsage: async () => {} });
mock(path.join(SERVER, 'automation/scheduleSync'), { syncSchedules: async () => {}, scheduleFingerprint: () => 'fp' });
mock(path.join(SERVER, 'automation/subscriptionSync'), {
    syncAppEventSubscription: async () => {}, revokeRemoteSubscriptions: async () => {},
    hasAppEventTrigger: () => false, appEventFingerprint: () => 'fp',
});
mock(path.join(SERVER, 'automation/approvalService'), { validateApprovalAssignees: async () => [] });
mock(path.join(SERVER, 'core/automationModel/agentCatalog'), { agentCatalogForOwner: async () => null });
mock(path.join(SERVER, 'automation/portability'), {
    buildExport: () => ({}), sanitizeImport: () => ({ automation: null, errors: [] }),
    rebindDatatables: (d) => d, rekeyDefinition: (d) => ({ definition: d }), collectPinnedNodes: () => [],
});
mock(path.join(SERVER, 'auth/datatableAccess'), {
    resolveDatatablePrincipal: async (req) => ({ userId: req.session.user.id, orgId: 'org1', organizationId: 'org1', identityError: null }),
});

const crudRouter = require('./crud');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

const create = findHandler(crudRouter, 'post', '/');

const OWNER = 'user-owner';
const OTHER = 'user-other';
const APP_ID = '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7';
const REF = { appId: APP_ID, screenId: 'scr_dash01', nodeId: 'cmp_btn123' };

/** What "New from this button" POSTs — an empty app_trigger with a back pointer. */
const DEF = (appRef) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'app_trigger', params: [], ...(appRef ? { appRef } : {}) },
    steps: [],
    edges: [],
});

async function post(userId, definition) {
    const res = makeRes();
    await create({
        session: { user: { id: userId } },
        body: { title: 'New automation for this app', description: '', triggerType: 'manual', definition },
    }, res);
    return res;
}

function reset() {
    CREATED = [];
    APPS = { [APP_ID]: { id: APP_ID, userId: OWNER, name: 'Expense claims' } };
    appLookups = [];
    appLookupThrows = false;
}

test('de app-eigenaar maakt hem, en de rij landt onder de app-eigenaar', async () => {
    reset();
    const res = await post(OWNER, DEF(REF));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(CREATED.length, 1, 'er hoort precies één automatisering gemaakt te zijn');
    assert.strictEqual(CREATED[0].userId, OWNER);
    assert.deepStrictEqual(appLookups, [APP_ID], 'de app-rij is echt gelezen, niet aangenomen');
});

test('een ANDER dan de app-eigenaar krijgt een weigering, en er wordt niets gemaakt', async () => {
    // This is the case that P4 has to close: the button created the automation under
    // `req.session.user.id`. As soon as session and app owner diverge — an installed or transferred Solution — that automation will run later with someone else's rights, or it refuses at the first click.
    reset();
    const res = await post(OTHER, DEF(REF));

    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'owner_mismatch');
    assert.match(res.body.error, /belongs to somebody else/i, 'de weigering legt uit waarom');
    assert.strictEqual(CREATED.length, 0, 'en er is niets stilzwijgend onder de klikker gemaakt');
});

test('een COLLEGA MET BEWERKRECHT is ook een ander — bewerkrecht is geen eigendom', async () => {
    // The case everyone assumes works, and which is precisely what must NOT happen. Someone who may EDIT the app (shared group, org access) is
    // not the person with whose rights the button will later run: automationBridge refuses on `automation.userId !== app.userId`, so created under the colleague
    // the button is broken from the first click, and created under the owner the colleague has written an automation that runs with someone else's rights. The gate therefore looks at `app.userId` and at nothing else — no canWrite, no shared group.
    reset();
    APPS[APP_ID] = {
        id: APP_ID, userId: OWNER, name: 'Expense claims',
        // Everything that "this colleague may access it here" could mean:
        sharedGroups: ['grp_team'], organizationId: 'org1',
    };
    const res = await post(OTHER, DEF(REF));

    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'owner_mismatch');
    assert.strictEqual(CREATED.length, 0, 'bewerkrecht mag geen automatisering onder andermans naam opleveren');
});

test('een app die niet bestaat is een weigering, geen automatisering zonder herkomst', async () => {
    reset();
    APPS = {};
    const res = await post(OWNER, DEF(REF));

    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'app_unknown');
    assert.strictEqual(CREATED.length, 0);
});

test('een ONLEESBARE eigenaar weigert — de store die eruit ligt is geen vrijbrief', async () => {
    // Never fail open on ownership. If studioAppStore falls over, the answer is
    // "I could not check it", and that is a refusal, not a guess.
    reset();
    appLookupThrows = true;
    const res = await post(OWNER, DEF(REF));

    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'app_unknown');
    assert.strictEqual(CREATED.length, 0);
});

test('een app-rij zonder eigenaar weigert, en wijst hem niet aan de klikker toe', async () => {
    reset();
    APPS[APP_ID] = { id: APP_ID, userId: null, name: 'Ownerless' };
    const res = await post(OWNER, DEF(REF));

    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'owner_unknown');
    assert.strictEqual(CREATED.length, 0);
});

test('een automatisering ZONDER back-pointer verandert niet: hij hoort bij wie hem maakt', async () => {
    // The gate may not levy a toll on any other way of creating an automation. No appRef → no app read, and the owner is the session.
    reset();
    const res = await post(OTHER, DEF(null));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(CREATED[0].userId, OTHER);
    assert.deepStrictEqual(appLookups, [], 'er is geen app opgezocht die niemand genoemd heeft');
});

test('een HALVE back-pointer komt er niet doorheen via de achterdeur', async () => {
    // `appTriggerRef` returns null for a half-written ref, so the
    // ownership gate skips it — but the validator refuses it all the same.
    // Net result: no automation, and certainly no automation with a half address.
    reset();
    const res = await post(OTHER, DEF({ appId: APP_ID, screenId: 'scr_dash01' }));

    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.ok((res.body.details || []).some(d => d.code === 'app_trigger.ref_incomplete'),
        `verwachtte de ref-regel, kreeg ${JSON.stringify((res.body.details || []).map(d => d.code))}`);
    assert.strictEqual(CREATED.length, 0);
});

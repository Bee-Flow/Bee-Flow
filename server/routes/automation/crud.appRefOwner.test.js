'use strict';

/**
 * P4 deel D — de EIGENDOMSPOORT op "Nieuwe vanuit deze knop", als BEDRADING.
 *
 * De pure regel staat in appStudio/appRefLookup.appRefOwnerVerdict en heeft
 * daar zijn eigen tests. Wat die niet dekken is de draad ertussen: de route
 * die de app-rij LAADT en de uitspraak toepast — inclusief de vraag welke
 * eigenaar er uiteindelijk in de kolom `automations.user_id` belandt.
 *
 * Waarom dat de moeite is: een automatisering gemaakt vanuit een app-knop wordt door
 * die knop ALS DE APP-EIGENAAR gedraaid (automationBridge weigert bij ongelijke
 * eigenaars). Zet de route hem stilzwijgend onder de klikker, dan is de knop
 * stuk vanaf de eerste klik; zet ze hem onder de app-eigenaar terwijl iemand
 * anders klikt, dan draait er straks andermans automatisering met de rechten van de
 * eigenaar. Vandaar: alleen doorgaan als die twee dezelfde persoon zijn, en
 * "ik kon het niet nagaan" is een weigering, geen gok.
 *
 * Alleen de database eronder is een dubbelganger; `validateDefinition`,
 * `appTriggerRef` en `appRefOwnerVerdict` zijn de echte.
 *
 * Draaien: cd server && node --test --test-reporter=tap routes/automation/crud.appRefOwner.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

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
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
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
mock(path.join(SERVER, 'automation/agentCatalog'), { agentCatalogForOwner: async () => null });
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

/** Wat "Nieuwe vanuit deze knop" POST — een lege app_trigger met back-pointer. */
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
    // Dit is het geval dat P4 moet dichtzetten: de knop maakte de automatisering onder
    // `req.session.user.id`. Zodra sessie en app-eigenaar uit elkaar lopen — een
    // geïnstalleerde of overgedragen Oplossing — draait die automatisering straks met
    // andermans rechten, of hij weigert bij de eerste klik.
    reset();
    const res = await post(OTHER, DEF(REF));

    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'owner_mismatch');
    assert.match(res.body.error, /belongs to somebody else/i, 'de weigering legt uit waarom');
    assert.strictEqual(CREATED.length, 0, 'en er is niets stilzwijgend onder de klikker gemaakt');
});

test('een COLLEGA MET BEWERKRECHT is ook een ander — bewerkrecht is geen eigendom', async () => {
    // Het geval waarvan iedereen aanneemt dat het werkt, en dat het juist niet
    // mag. Iemand die de app mag BEWERKEN (gedeelde groep, org-toegang) is niet
    // de persoon met wiens rechten de knop straks draait: automationBridge
    // weigert op `automation.userId !== app.userId`, dus onder de collega
    // gemaakt is de knop stuk vanaf de eerste klik, en onder de eigenaar
    // gemaakt heeft de collega een automatisering geschreven die met andermans
    // rechten draait. De poort kijkt daarom naar `app.userId` en naar niets
    // anders — geen canWrite, geen gedeelde groep.
    reset();
    APPS[APP_ID] = {
        id: APP_ID, userId: OWNER, name: 'Expense claims',
        // Alles wat "deze collega mag hier bij" zou kunnen betekenen:
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
    // Faal nooit open op eigendom. Valt studioAppStore om, dan is het antwoord
    // "ik kon het niet nagaan" en dat is een weigering, geen gok.
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
    // De poort mag geen tol heffen op elke andere manier om een automatisering te
    // maken. Geen appRef → geen app-lees, en de eigenaar is de sessie.
    reset();
    const res = await post(OTHER, DEF(null));

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(CREATED[0].userId, OTHER);
    assert.deepStrictEqual(appLookups, [], 'er is geen app opgezocht die niemand genoemd heeft');
});

test('een HALVE back-pointer komt er niet doorheen via de achterdeur', async () => {
    // `appTriggerRef` geeft null terug voor een half geschreven ref, dus de
    // eigendomspoort slaat hem over — maar de validator weigert hem alsnog.
    // Netto: geen automatisering, en zeker geen automatisering met een half adres.
    reset();
    const res = await post(OTHER, DEF({ appId: APP_ID, screenId: 'scr_dash01' }));

    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.ok((res.body.details || []).some(d => d.code === 'app_trigger.ref_incomplete'),
        `verwachtte de ref-regel, kreeg ${JSON.stringify((res.body.details || []).map(d => d.code))}`);
    assert.strictEqual(CREATED.length, 0);
});

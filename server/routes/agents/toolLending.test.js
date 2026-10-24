/**
 * GET /agents/:id/tool-lending — may this agent borrow a connection of its
 * OWNER, and for which apps?
 *
 * This route exists because the card first asked that question of itself: the
 * Tools card read `GET /api/integrations/connections/grants`, and that route
 * filters unconditionally on the LOGGED-IN user (routes/integrations/
 * connections.js — `grantorUserId: userId`). The runtime, on the other hand, borrows from
 * `agent.owner_id` (toolPolicy.resolveLentProviders, called with
 * `agent.owner_id` in routes/agents/crud.js and stores/agent/agentCrud.js). For a
 * shared or org agent those are two different people, and then the screen offered
 * a choice that the runtime executed differently — in both directions.
 *
 * What is pinned here is not "the route returns JSON", but the three properties on which a
 * reassuring implementation goes wrong:
 *
 *   • the question is about the OWNER. The grants of the editor are no basis for "as you";
 *   • the answer is a YES/NO PER APP and nothing else. No label, no
 *     connection id, no beneficiary — otherwise the editor learns which integrations the owner has
 *     that the editor may not see;
 *   • UNKNOWN NARROWS. No owner, a broken probe, a broken attribution: all three
 *     `readable: false` with an empty list — never silently "yes", and also never an
 *     empty list that reads as "read zero". "Lending is off" IS a read zero: that is a fact,
 *     not a failure, and the card should not show an error message for it.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/toolLending.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..');
const stub = (rel, exports) => {
    const id = require.resolve(path.join(SERVER, rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── Fixture ─────────────────────────────────────────────────────────
const fx = {
    userId: 'editor-u',
    agents: {},
    canRead: true,
    canModify: true,
    lendingEnabled: true,
    lendingThrows: false,
    grantsThrows: false,
    // grantor → de grants die die persoon voor deze agent heeft uitgeleend.
    grantsByGrantor: {},
    grantCalls: [],
    loadThrowsFor: null,
    // De config zoals de RUNTIME hem leest (published_config, geklemd).
    runtimeConfig: {},
    runtimeThrows: false,
};

// ── Stubs, vóór de route (en vóór toolPolicy) geïnstalleerd ─────────
stub('stores/agentStore', {
    getAgent: async (id) => (fx.agents[id] ? { ...fx.agents[id] } : null),
    // What the RUNTIME reads — the published config, not the draft that the
    // editor is working on. `null` = not readable.
    getForRuntime: async (id) => {
        if (fx.runtimeThrows) throw new Error('runtime config unreadable');
        if (!fx.agents[id]) return null;
        return { ...fx.agents[id], config: fx.runtimeConfig };
    },
});
stub('routes/agents/crud', {
    canReadAgent: async () => fx.canRead,
    canModifyAgent: async () => fx.canModify,
});
stub('core/integrations/connectionResolution', {
    isLendingEnabled: () => {
        if (fx.lendingThrows) throw new Error('lending flag unreadable');
        return fx.lendingEnabled;
    },
    providerForTool: (n) => {
        if (String(n).startsWith('gmail_')) return 'google';
        if (String(n).startsWith('outlook_')) return 'microsoft';
        return null;
    },
});
stub('stores/integrationConnectionStore', {
    listGrants: async (filter) => {
        fx.grantCalls.push(filter);
        if (fx.grantsThrows) throw new Error('grants unreachable');
        return fx.grantsByGrantor[filter.grantorUserId] || [];
    },
});
const LENDING_TOOLS = {
    gmail: [{ function: { name: 'gmail_search' } }, { function: { name: 'gmail_compose' } }],
    outlook: [{ function: { name: 'outlook_search' } }, { function: { name: 'outlook_compose' } }],
    // Two entries over the SAME module, as the real source has had since A2-4. Without such a
    // pair in the stub this suite cannot see that the route returned an app for which the
    // storage REFUSES `actAs: 'owner'`.
    'outlook-readonly': [{ function: { name: 'outlook_search' } }],
    'agent-search': [{ function: { name: 'web_search' } }],
};
stub('automation/toolRegistry', {
    TOOL_REGISTRY: [],
    get ALL_TOOL_APPS() {
        return [
            { app: 'gmail', label: 'Gmail' },
            { app: 'outlook', label: 'Outlook' },
            { app: 'outlook-readonly', label: 'Outlook (read-only)', grantsVia: 'outlook' },
            { app: 'agent-search', label: 'Web search' },
        ];
    },
    loadTools: (entry) => LENDING_TOOLS[entry.app] || [],
    // Zoals de echte bron: `loadTools` gooit niet, de storing komt als waarde
    // terug. De oude stub liet hem GOOIEN — de enige vorm die de echte bron
    // nooit produceert, dus de degraded-tak was groen op iets onbereikbaars.
    loadToolsResult: (entry) => (entry.app === fx.loadThrowsFor
        ? { tools: [], ok: false, reason: 'require_failed' }
        : { tools: LENDING_TOOLS[entry.app] || [], ok: true, reason: null }),
});

const policy = require('../../core/agentRuntime/toolPolicy');
const router = require('./toolLending');

// ── Dispatch zonder poort: de router krijgt een kaal req/res-paar ───
function dispatch(url, session = { user: { id: fx.userId } }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url, originalUrl: url, path: url, body: {}, query: {}, headers: {}, session,
            get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: GET ${url}`)));
    });
}

const AGENT = (over = {}) => ({
    id: 'a1', owner_id: 'owner-u', organization_id: 'org1', is_published: true, ...over,
});
// Like the real row: `resource_type`/`resource_id`/`expires_at`/`revoked_at`
// are ALWAYS present. The old fixture left out exactly those four, and those are the
// columns on which this route decides.
const GRANT = (provider, over = {}) => ({
    id: 'g-1', provider, connection_id: 'c-1', connection_label: 'Werkmail van Sam',
    grantee_id: 'grp-1', grantee_type: 'group', owner_user_id: 'owner-u',
    resource_type: 'agent', resource_id: 'a1', expires_at: null, revoked_at: null, ...over,
});

test.beforeEach(() => {
    fx.userId = 'editor-u';
    fx.agents = { a1: AGENT() };
    fx.canRead = true;
    fx.canModify = true;
    fx.lendingEnabled = true;
    fx.lendingThrows = false;
    fx.grantsThrows = false;
    fx.grantsByGrantor = {};
    fx.grantCalls = [];
    fx.loadThrowsFor = null;
    fx.runtimeConfig = {};
    fx.runtimeThrows = false;
    policy._resetAppIndex();
});

// ── De kern van de bevinding ────────────────────────────────────────

test('de leen-vraag gaat over de EIGENAAR, niet over de ingelogde bewerker', async () => {
    // De eigenaar leende Google uit voor deze agent; de bewerker leende
    // Microsoft uit (voor deze agent, want hij mag hem bewerken).
    fx.grantsByGrantor = {
        'owner-u': [GRANT('google')],
        'editor-u': [GRANT('microsoft', { id: 'g-2' })],
    };

    const res = await dispatch('/a1/tool-lending');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.readable, true);
    assert.deepStrictEqual(res.body.apps, ['gmail'],
        'gmail leent van google — de provider die de EIGENAAR uitleende');

    assert.ok(fx.grantCalls.length >= 1, 'er is naar grants gevraagd');
    for (const call of fx.grantCalls) {
        assert.strictEqual(call.grantorUserId, 'owner-u',
            'de grants van de agent-EIGENAAR, nooit die van de bewerker');
    }
});

test('de resource-filtering volgt dispatch: deze agent én de org-brede lening', async () => {
    // `resolveConnectionForRun` honours two forms — the grant ON this agent
    // and the grant without a resource — and the route only did the first. An org-wide
    // loan therefore read as "nothing is lent out", while the
    // runtime was in fact running on it.
    fx.grantsByGrantor = {
        'owner-u': [
            GRANT('google', { resource_type: null, resource_id: null }),
            GRANT('microsoft', { id: 'g-2', resource_type: 'agent', resource_id: 'een-andere-agent' }),
        ],
    };

    const { body } = await dispatch('/a1/tool-lending');
    assert.strictEqual(body.readable, true);
    assert.deepStrictEqual(body.apps, ['gmail'],
        'de org-brede google-lening telt; de microsoft-lening voor een ANDERE agent niet');
});

test('een VERLOPEN lening is geen lening', async () => {
    // `listGrants` filters only on revoked_at; `resolveConnectionForRun` ALSO requires
    // `expires_at IS NULL OR expires_at > NOW()`. If the card read the expired
    // grant as live, normalisation would keep an `actAs: 'owner'` that matched nothing at dispatch — and it would
    // become real again by itself at the next grant, without anyone choosing it again.
    fx.grantsByGrantor = {
        'owner-u': [
            GRANT('google', { expires_at: new Date(Date.now() - 60000).toISOString() }),
            GRANT('microsoft', { id: 'g-2', expires_at: new Date(Date.now() + 3600000).toISOString() }),
        ],
    };

    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(body.apps, ['outlook'], 'alleen de nog geldige lening');

    // Een vervaldatum die niemand kan lezen telt óók als verlopen.
    fx.grantsByGrantor = { 'owner-u': [GRANT('google', { expires_at: 'ooit' })] };
    const second = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(second.body.apps, [], 'onbekend versmalt');
});

test('een app die zijn grants elders laat lopen komt NIET in de leenlijst', async () => {
    // `outlook-readonly` provides the tools of `outlook` on the same credentials.
    // `normaliseToolsConfig` refuses `actAs: 'owner'` on exactly that app, so naming
    // it here made the card offer a switch that the storage reverted a line later — without even
    // showing the refusal message.
    fx.grantsByGrantor = { 'owner-u': [GRANT('microsoft')] };

    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(body.apps, ['outlook'],
        'de app die de namen BEZIT staat er; de rij die ze uitleent niet');
});

test('runtimeCurated komt van de RUNTIME-lezing, niet van het concept', async () => {
    fx.grantsByGrantor = { 'owner-u': [GRANT('google')] };

    fx.runtimeConfig = {};
    assert.strictEqual((await dispatch('/a1/tool-lending')).body.runtimeCurated, false,
        'een lege map is geen curatie — precies zoals hasCuratedGrants hem leest');

    fx.runtimeConfig = { tools: { gmail: { actions: ['gmail_search'] } } };
    assert.strictEqual((await dispatch('/a1/tool-lending')).body.runtimeCurated, true);

    fx.runtimeThrows = true;
    assert.strictEqual((await dispatch('/a1/tool-lending')).body.runtimeCurated, null,
        'niet te lezen is geen "niet gecureerd" — de kaart hoort er dan niets over te zeggen');
});

test('de grants van de bewerker zijn geen grond voor "als jou"', async () => {
    fx.grantsByGrantor = { 'editor-u': [GRANT('google')] };   // eigenaar leende niets

    const { body } = await dispatch('/a1/tool-lending');
    assert.strictEqual(body.readable, true);
    assert.deepStrictEqual(body.apps, [],
        'de bewerker leende google uit, de eigenaar niet — dan valt er niets te lenen');
});

test('het antwoord noemt apps en niets anders — geen verbinding, geen begunstigde', async () => {
    fx.grantsByGrantor = { 'owner-u': [GRANT('google'), GRANT('microsoft', { id: 'g-2' })] };

    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(Object.keys(body).sort(), ['apps', 'readable', 'runtimeCurated'],
        'welke apps geleend kunnen worden, of dat gelezen kon worden, en of de RUNTIME '
        + 'deze agent als gecureerd ziet — meer niet');
    assert.deepStrictEqual(body.apps, ['gmail', 'outlook']);
    const dump = JSON.stringify(body);
    for (const leak of ['Werkmail van Sam', 'c-1', 'g-1', 'grp-1', 'owner-u']) {
        assert.ok(!dump.includes(leak), `lekt "${leak}" — de bewerker hoort alleen ja/nee per app te krijgen`);
    }
});

// ── Onbekend versmalt ───────────────────────────────────────────────

test('een agent zonder eigenaar is GEEN ja: geen leenkeuze, en het zegt waarom', async () => {
    fx.agents = { a1: AGENT({ owner_id: null }) };
    fx.grantsByGrantor = { 'editor-u': [GRANT('google')] };

    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(body.apps, []);
    assert.strictEqual(body.readable, false,
        '"ik weet niet wiens verbinding dit zou zijn" is geen gelezen nul');
    assert.strictEqual(fx.grantCalls.length, 0,
        'zonder eigenaar wordt er niet alsnog op iemand anders gefilterd');
});

test('een probe die stuk is is GEEN ja', async () => {
    fx.grantsThrows = true;
    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(body.apps, []);
    assert.strictEqual(body.readable, false);
});

test('attributie die stuk is is GEEN ja — de app→provider-kaart is dan een gok', async () => {
    fx.loadThrowsFor = 'gmail';
    policy._resetAppIndex();
    fx.grantsByGrantor = { 'owner-u': [GRANT('google')] };

    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(body.apps, []);
    assert.strictEqual(body.readable, false);
});

test('lenen uit is een GELEZEN nul, geen mislukking', async () => {
    fx.lendingEnabled = false;
    fx.grantsByGrantor = { 'owner-u': [GRANT('google')] };

    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(body.apps, []);
    assert.strictEqual(body.readable, true,
        'de kaart hoort hier geen "kon het niet lezen" te tonen — er valt niets te lenen');
    assert.strictEqual(fx.grantCalls.length, 0, 'geen databasewerk voor een uitgeschakelde functie');
});

test('een vlag die niet gelezen kan worden is GEEN ja', async () => {
    fx.lendingThrows = true;
    const { body } = await dispatch('/a1/tool-lending');
    assert.deepStrictEqual(body.apps, []);
    assert.strictEqual(body.readable, false);
});

// ── De poort ────────────────────────────────────────────────────────

test('wie de agent niet mag zien krijgt dezelfde 404 als GET /:id', async () => {
    fx.canRead = false;
    const res = await dispatch('/a1/tool-lending');
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.grantCalls.length, 0);
});

test('wie de agent niet mag bewerken krijgt 403 — dit is een editor-antwoord', async () => {
    fx.canModify = false;
    const res = await dispatch('/a1/tool-lending');
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
    assert.strictEqual(fx.grantCalls.length, 0,
        'geen probe voor iemand die het antwoord niet hoort te krijgen');
});

test('een agent die niet bestaat is 404', async () => {
    const res = await dispatch('/nope/tool-lending');
    assert.strictEqual(res.statusCode, 404);
});

/**
 * GET /agents/tool-catalog — the ungated app+action source the agent tool
 * picker reads.
 *
 * What is pinned here is not "the endpoint returns JSON". It is the three
 * answers this route may give and the one it may NOT: an app is available,
 * an app is not available, or nobody could check — and "nobody could check"
 * never comes back as "not available". That distinction is the whole reason
 * this route exists next to /api/automation/catalog, which flattens a failed
 * gate into `available: false`.
 *
 * Run: node --test --test-force-exit routes/agents/toolCatalog.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

const SERVER = path.join(__dirname, '..', '..');

// ── Stubs, installed before the route is required ───────────────────
const CATALOG_TOOLS = {
    gmail: [
        { function: { name: 'gmail_search', description: 'Search mail' } },
        { function: { name: 'gmail_compose', description: 'Write mail' } },
    ],
    'agent-search': [{ function: { name: 'web_search', description: 'Search the web' } }],
    'broken-app': [{ function: { name: 'broken_do' } }],
    'browser-fetch': [{ function: { name: 'browse_web', description: 'Drive a browser' } }],
    // Twee entries over DEZELFDE module: `outlook` bezit de namen, de
    // read-only rij levert er een strikte subset van. De echte bron geeft dat
    // sinds A2-4 terug (`grantsVia`); een stub zonder zo'n paar kan niet zien
    // dat de catalogus er iets over moet zeggen.
    outlook: [
        { function: { name: 'outlook_search', description: 'Search mail' } },
        { function: { name: 'outlook_read', description: 'Read a mail' } },
        { function: { name: 'outlook_compose', description: 'Write mail' } },
    ],
    'outlook-readonly': [
        { function: { name: 'outlook_search', description: 'Search mail' } },
        { function: { name: 'outlook_read', description: 'Read a mail' } },
    ],
};

const registryPath = require.resolve(path.join(SERVER, 'automation/toolRegistry'));
let LOAD_THROWS_FOR = null;
require.cache[registryPath] = {
    id: registryPath, filename: registryPath, loaded: true,
    exports: {
        TOOL_REGISTRY: [
            { app: 'gmail', label: 'Gmail' },
            { app: 'agent-search', label: 'Web search' },
            { app: 'broken-app', label: 'Broken' },
            { app: 'outlook', label: 'Outlook' },
            { app: 'outlook-readonly', label: 'Outlook (read-only)', grantsVia: 'outlook' },
        ],
        // De apps die hun tools INLINE injecteren. Ze staan bewust niet in
        // TOOL_REGISTRY (dat snijdt andere antwoorden), maar de kiezer moet ze
        // wél kunnen tonen — anders schrijft hij nooit een weigering voor ze
        // weg en houdt een gecureerde agent ze stilzwijgend.
        INLINE_TOOL_APPS: [
            {
                app: 'browser-fetch', label: 'Browse Web',
                // Zoals de echte rij: TWEE mogelijke oorzaken (de docker-probe
                // en het org-entitlement), niet één.
                grantsRequireEntry: true, availability: ['installation', 'permission'],
            },
        ],
        get ALL_TOOL_APPS() {
            return [...this.TOOL_REGISTRY, ...this.INLINE_TOOL_APPS];
        },
        loadTools: (entry) => (entry.app === LOAD_THROWS_FOR ? [] : (CATALOG_TOOLS[entry.app] || [])),
        // ZOALS DE ECHTE BRON. `loadTools` gooit niet — hij vangt zelf en geeft
        // `[]` terug — dus een route die op een throw wachtte, wachtte op iets
        // dat nooit komt. De storing hoort als WAARDE terug te komen: een app
        // met een lege actielijst is iets anders dan een app die niet te lezen
        // was, en alleen de tweede mag "actionsKnown: false" opleveren.
        loadToolsResult: (entry) => (entry.app === LOAD_THROWS_FOR
            ? { tools: [], ok: false, reason: 'require_failed' }
            : { tools: CATALOG_TOOLS[entry.app] || [], ok: true, reason: null }),
    },
};

const effectPath = require.resolve(path.join(SERVER, 'automation/sideEffectMap'));
require.cache[effectPath] = {
    id: effectPath, filename: effectPath, loaded: true,
    exports: {
        effectOf: (n) => (n === 'gmail_compose' ? 'sends' : 'reads'),
        isSideEffect: (n) => n === 'gmail_compose',
    },
};

const authPath = require.resolve(path.join(SERVER, 'auth'));
require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { requireAuth: (req, res, next) => next() },
};

const itPath = require.resolve(path.join(SERVER, 'core/integrations/integrationTools'));
let GATE_THROWS = false;
let GATE_TOOLS = ['gmail_search', 'gmail_compose'];
require.cache[itPath] = {
    id: itPath, filename: itPath, loaded: true,
    exports: {
        getIntegrationTools: async () => {
            if (GATE_THROWS) throw new Error('gate unavailable');
            return { tools: GATE_TOOLS.map(n => ({ function: { name: n } })) };
        },
    },
};

const crPath = require.resolve(path.join(SERVER, 'core/integrations/connectionResolution'));
let LENDING = false;
require.cache[crPath] = {
    id: crPath, filename: crPath, loaded: true,
    exports: {
        isLendingEnabled: () => LENDING,
        providerForTool: (n) => (String(n).startsWith('gmail_') ? 'google' : null),
    },
};

const routeRouter = require('./toolCatalog');

// ── A real express app, so the route is exercised through its chain ──
function makeApp() {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { id: 'u1' } }; next(); });
    app.use('/agents', routeRouter);
    return app;
}

async function get(url = '/agents/tool-catalog') {
    const app = makeApp();
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}${url}`);
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

const appNamed = (body, id) => body.apps.find(a => a.id === id);

test('the catalog answers the four questions the picker asks', async () => {
    GATE_THROWS = false;
    GATE_TOOLS = ['gmail_search', 'gmail_compose'];
    LENDING = true;
    LOAD_THROWS_FOR = null;

    const { status, body } = await get();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.degraded, false);
    assert.strictEqual(body.providersKnown, true);
    assert.strictEqual(body.lendingEnabled, true);

    const gmail = appNamed(body, 'gmail');
    assert.strictEqual(gmail.available, true, 'a tool of this app is in the caller\'s resolved set');
    assert.strictEqual(gmail.provider, 'google', 'it borrows a user connection');
    assert.deepStrictEqual(gmail.actions.map(a => a.name), ['gmail_search', 'gmail_compose']);
    assert.deepStrictEqual(gmail.actions.map(a => a.effect), ['reads', 'sends'],
        'the effect is what the confirmation rule is decided on — it has to be in the payload');

    const search = appNamed(body, 'agent-search');
    assert.strictEqual(search.available, false, 'this one is genuinely NOT in the resolved set');
    assert.strictEqual(search.provider, null,
        'no user connection — the editor draws a static "as Bee Flow" and stores no actAs');
});

test('a gate that could not run is `null`, never `false`', async () => {
    GATE_THROWS = true;
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    assert.strictEqual(body.degraded, true, 'the client is told which half of the page it may believe');
    for (const app of body.apps) {
        assert.strictEqual(app.available, null,
            `${app.id}: "I could not check" is not "you may not use this" — the second is a claim`);
        assert.notStrictEqual(app.available, false);
    }
});

test('an app whose module fails to load reports unknown actions, not zero actions', async () => {
    GATE_THROWS = false;
    LOAD_THROWS_FOR = 'broken-app';

    const { body } = await get();
    const broken = appNamed(body, 'broken-app');
    assert.strictEqual(broken.actionsKnown, false,
        'an empty action list would read as "this app has nothing to grant"');
    assert.deepStrictEqual(broken.actions, []);
    assert.strictEqual(broken.available, null, 'and availability is unknowable without the names');

    // One broken app does not take the rest of the catalog down.
    assert.strictEqual(appNamed(body, 'gmail').actionsKnown, true);
    assert.strictEqual(appNamed(body, 'gmail').available, true);
});

// ── De apps die geen TOOLS-array-module zijn (A2-1) ─────────────────
// `browse_web` werd inline geregistreerd en stond dus in geen enkele lijst die
// deze route leest. Zolang de kiezer hem niet TOONT, schrijft hij er ook nooit
// een weigering voor weg — en houdt een agent die tot één Gmail-actie werd
// versmald in stilte een volledige browser.

test('een inline app staat in de catalogus, met zijn acties', async () => {
    GATE_THROWS = false;
    GATE_TOOLS = ['gmail_search', 'gmail_compose', 'browse_web'];
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    const browser = appNamed(body, 'browser-fetch');
    assert.ok(browser, 'de kiezer kan niet tonen wat de catalogus niet noemt');
    assert.deepStrictEqual(browser.actions.map(a => a.name), ['browse_web']);
    assert.strictEqual(browser.actionsKnown, true);
    assert.strictEqual(browser.available, true);
    // De kiezer moet weten dat zwijgen hier NIET "de hele app" betekent —
    // anders opent hij deze app met alle vinkjes aan terwijl de runtime niets
    // gunt, en dat verschil is precies wat de rij zou verzwijgen.
    assert.strictEqual(browser.requiresGrant, true);
    assert.strictEqual(appNamed(body, 'gmail').requiresGrant, false,
        'een gewone registry-app houdt de geen-migratie-regel');
});

test('meer dan één mogelijke oorzaak ⇒ GEEN enkele oorzaak beweren', async () => {
    // `availabilityKind` is een statisch veld op de registryrij, maar
    // `available: false` heeft per app meerdere dynamische oorzaken:
    // `browse_web` zit achter de docker-probe ÉN achter het org-entitlement.
    // Eén ervan noemen is een bewering die de meting niet oplevert.
    GATE_THROWS = false;
    GATE_TOOLS = ['gmail_search'];
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    const browser = appNamed(body, 'browser-fetch');
    assert.deepStrictEqual(browser.availabilityKinds, ['installation', 'permission']);
    assert.strictEqual(browser.availabilityKind, null,
        'de kaart mag hier geen van beide zinnen als DE reden zetten');

    const gmail = appNamed(body, 'gmail');
    assert.deepStrictEqual(gmail.availabilityKinds, ['connection']);
    assert.strictEqual(gmail.availabilityKind, 'connection', 'één oorzaak blijft één zin');
});

test('"niet beschikbaar op deze installatie" is een ANDER antwoord dan "niet verbonden"', async () => {
    // De docker-probe zegt nee: browse_web zit niet in de opgeloste set.
    GATE_THROWS = false;
    GATE_TOOLS = ['gmail_search', 'gmail_compose'];
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    const browser = appNamed(body, 'browser-fetch');
    assert.ok(browser, 'afwezig zijn is geen reden om de rij weg te laten — dan is hij niet te kiezen');
    assert.strictEqual(browser.available, false);
    assert.deepStrictEqual(browser.availabilityKinds, ['installation', 'permission'],
        'de kiezer moet kunnen zeggen WAAROM — en voor deze app zijn dat er twee: ' +
        'deze installatie heeft geen browser, of dit account mag hem niet. Allebei ' +
        'iets anders dan een verbinding die de gebruiker niet legde');
    assert.strictEqual(browser.availabilityKind, null,
        'en met twee mogelijke oorzaken wijst de kaart er geen aan');
    assert.strictEqual(appNamed(body, 'gmail').availabilityKind, 'connection');
    assert.deepStrictEqual(appNamed(body, 'gmail').availabilityKinds, ['connection']);
});

test('een gate die niet kon draaien laat ook de inline app op `null` staan', async () => {
    GATE_THROWS = true;
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    const browser = appNamed(body, 'browser-fetch');
    assert.strictEqual(browser.available, null,
        '"ik kon het niet nagaan" is niet "deze installatie heeft hem niet"');
    assert.strictEqual(browser.requiresGrant, true, 'de grant-regel hangt niet aan de gate');
});

test('lending off is reported, so the editor never offers what the runtime would refuse', async () => {
    GATE_THROWS = false;
    LOAD_THROWS_FOR = null;
    LENDING = false;

    const { body } = await get();
    assert.strictEqual(body.lendingEnabled, false);
});

// ── Twee rijen over dezelfde module ─────────────────────────────────

test('de rij draagt `grantsVia` — de kiezer moet weten dat twee rijen één subject zijn', async () => {
    GATE_THROWS = false;
    GATE_TOOLS = ['outlook_search', 'outlook_read', 'outlook_compose'];
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    assert.strictEqual(appNamed(body, 'outlook').grantsVia, null, 'de eigenaar stelt niets uit');
    assert.strictEqual(appNamed(body, 'outlook-readonly').grantsVia, 'outlook');
    assert.strictEqual(appNamed(body, 'gmail').grantsVia, null);
});

test('de read-only rij is NIET "beschikbaar" zodra de volledige rij dat is', async () => {
    // `available` werd berekend als "zit één van mijn namen in de lijst", en
    // die twee rijen DELEN hun namen: de read-only rij las dus `true` puur door
    // overlap met de rij die de org juist had aangezet. De kiezer toonde dan
    // twee losse subjecten voor hetzelfde gereedschap, en één vinkje op de ene
    // rij nam er stil twee af op de andere.
    GATE_THROWS = false;
    GATE_TOOLS = ['outlook_search', 'outlook_read', 'outlook_compose'];
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    assert.strictEqual(appNamed(body, 'outlook').available, true,
        'de EXCLUSIEVE naam (outlook_compose) zit erin, dus deze rij staat echt aan');
    assert.strictEqual(appNamed(body, 'outlook-readonly').available, false,
        'de bredere rij vervangt hem volledig — hij gaat nergens meer over');
});

test('heeft de gebruiker ALLEEN de read-only smaak, dan is dát de rij die aanstaat', async () => {
    GATE_THROWS = false;
    GATE_TOOLS = ['outlook_search', 'outlook_read'];      // geen compose
    LOAD_THROWS_FOR = null;

    const { body } = await get();
    assert.strictEqual(appNamed(body, 'outlook').available, false,
        'geen enkele exclusieve naam van de volledige rij — die staat dus niet aan');
    assert.strictEqual(appNamed(body, 'outlook-readonly').available, true);
});

test('een gate die niet kon draaien laat allebei de rijen op `null`', async () => {
    GATE_THROWS = true;
    LOAD_THROWS_FOR = null;
    const { body } = await get();
    assert.strictEqual(appNamed(body, 'outlook').available, null);
    assert.strictEqual(appNamed(body, 'outlook-readonly').available, null,
        '"ik kon het niet checken" is geen "hij is er niet"');
});

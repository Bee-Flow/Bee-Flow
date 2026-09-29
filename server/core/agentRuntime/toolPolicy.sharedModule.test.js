/**
 * Twee registry-entries, ÉÉN set toolnamen (A2-4).
 *
 * ── DE BEVINDING ────────────────────────────────────────────────────
 * `outlook` en `outlook-readonly` staan allebei in het registry en laden
 * dezelfde module; de read-only variant is een strikte SUBSET van dezelfde
 * drie namen op dezelfde credentials. De attributie-index deelde een naam toe
 * aan de EERSTE entry die hem noemde, dus `outlook` bezat `outlook_search`,
 * `outlook_read` en `outlook_list_recent` en `outlook-readonly` bezat er nul.
 *
 * Gevolg: een grant die op `outlook-readonly` was opgeslagen — de kiezer toont
 * hem als eigen app met drie acties, dus hij is gewoon op te slaan — ging
 * NERGENS over. `isToolAllowed` loste de naam op naar `outlook`, vond daar
 * geen entry, en las dat als "elke actie". Ook `{actions: []}` — "ik heb deze
 * app helemaal uitgevinkt" — hield niets tegen. Precies wat de modulekop
 * verbiedt: elk veld hier wordt gehandhaafd, of het wordt niet opgeslagen.
 *
 * ── DE REGEL DIE HET DICHT ──────────────────────────────────────────
 * Claimt meer dan één app dezelfde toolnaam, dan moet ELKE claimende app die
 * naam toestaan. Dat is de smalste lezing en dus de enige die nooit
 * verbreedt: een ontbrekende entry blijft "elke actie van deze app" (de
 * geen-migratie-regel), en een entry die de naam níét noemt is een weigering
 * die blijft staan.
 *
 * De EIGENAAR van een gedeelde naam volgt daarnaast een declaratie
 * (`grantsVia` in automation/toolRegistry.js) en niet de volgorde van de
 * lijst. Wie eigenaar is bepaalt waar de identiteitsvraag (`actAs`) wordt
 * beantwoord — één credential, één antwoord — en dat mag niet omslaan doordat
 * iemand twee regels in het registry omwisselt.
 *
 * Fake apps, geen echte: wat hier gepind wordt is de VORM, niet welke
 * integraties deze week meeliften. Dat de echte registry zich aan de vorm
 * houdt, bewaakt automation/toolRegistry.test.js.
 *
 * Run: node --test --test-force-exit core/agentRuntime/toolPolicy.sharedModule.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..');

// ── Registry-stub: één module, twee entries ─────────────────────────
// `tickets` bezit drie namen; `tickets-readonly` levert er twee van, op
// dezelfde credentials, en zegt met `grantsVia` dat de grants van de eigenaar
// gelden.
const OWNER_ENTRY = { app: 'tickets', label: 'Tickets' };
const ALIAS_ENTRY = { app: 'tickets-readonly', label: 'Tickets (read-only)', grantsVia: 'tickets' };
const OTHER_ENTRY = { app: 'gmail', label: 'Gmail' };

let REGISTRY_ENTRIES = [OTHER_ENTRY, OWNER_ENTRY, ALIAS_ENTRY];

const SHARED_TOOLS = {
    gmail: [{ function: { name: 'gmail_search' } }],
    tickets: [
        { function: { name: 'tix_list' } },
        { function: { name: 'tix_read' } },
        { function: { name: 'tix_close' } },
    ],
    'tickets-readonly': [
        { function: { name: 'tix_list' } },
        { function: { name: 'tix_read' } },
    ],
};
/** Apps waarvan de module niet laadt (leeg = alles laadt). */
const LOAD_FAILS_FOR = new Set();

const registryPath = require.resolve(path.join(SERVER, 'automation/toolRegistry'));
require.cache[registryPath] = {
    id: registryPath, filename: registryPath, loaded: true,
    exports: {
        get TOOL_REGISTRY() { return REGISTRY_ENTRIES; },
        get INLINE_TOOL_APPS() { return []; },
        get ALL_TOOL_APPS() { return REGISTRY_ENTRIES; },
        loadTools: (entry) => SHARED_TOOLS[entry.app] || [],
        // Zoals de echte bron: een module die niet laadt geeft geen exception
        // maar `ok: false` — het verschil tussen "deze app heeft geen tools" en
        // "ik kon deze app niet lezen".
        loadToolsResult: (entry) => (LOAD_FAILS_FOR.has(entry.app)
            ? { tools: [], ok: false, reason: 'require_failed' }
            : { tools: SHARED_TOOLS[entry.app] || [], ok: true, reason: null }),
    },
};

const crPath = require.resolve(path.join(SERVER, 'core/integrations/connectionResolution'));
let LENDING_ON = false;
require.cache[crPath] = {
    id: crPath, filename: crPath, loaded: true,
    exports: {
        isLendingEnabled: () => LENDING_ON,
        providerForTool: (n) => (String(n).startsWith('tix_') ? 'ticketing' : null),
    },
};

const P = require('./toolPolicy');

/** Zet de registry-volgorde en gooi de gememoiseerde index weg. */
function setRegistry(entries) {
    REGISTRY_ENTRIES = entries;
    P._resetAppIndex();
}

test.afterEach(() => setRegistry([OTHER_ENTRY, OWNER_ENTRY, ALIAS_ENTRY]));

// ── Wie bezit een gedeelde naam ─────────────────────────────────────

test('de eigenaar van een gedeelde naam volgt de DECLARATIE, niet de volgorde', () => {
    setRegistry([OTHER_ENTRY, OWNER_ENTRY, ALIAS_ENTRY]);
    assert.strictEqual(P.appIdForTool('tix_list'), 'tickets');

    // Dezelfde twee entries, omgedraaid. Onder "de eerste wint" verhuisde het
    // eigendom hier naar de alias — en daarmee de plek waar `actAs` wordt
    // gelezen, terwijl niemand een grant verplaatste.
    setRegistry([OTHER_ENTRY, ALIAS_ENTRY, OWNER_ENTRY]);
    assert.strictEqual(P.appIdForTool('tix_list'), 'tickets',
        'een app die zijn grants via een ander laat lopen, bezit nooit een naam');
    assert.strictEqual(P.appIdForTool('tix_close'), 'tickets');
    assert.strictEqual(P.appIdForTool('gmail_search'), 'gmail');
});

test('beide apps houden hun eigen actielijst — de alias is geen lege app', () => {
    assert.deepStrictEqual(P.actionsOfApp('tickets'), ['tix_list', 'tix_read', 'tix_close']);
    assert.deepStrictEqual(P.actionsOfApp('tickets-readonly'), ['tix_list', 'tix_read'],
        'de kiezer toont deze drie/twee acties; als de index ze niet kent, kan '
        + 'normalisatie ze niet eens valideren');
});

// ── Een opgeslagen grant beslist ────────────────────────────────────

test('een grant op de alias beslist over de namen waarop hij is opgeslagen', () => {
    const cfg = { 'tickets-readonly': { actions: ['tix_list'] } };

    assert.strictEqual(P.isToolAllowed('tix_list', cfg), true, 'expliciet gekozen');
    assert.strictEqual(P.isToolAllowed('tix_read', cfg), false,
        'de eigenaar noemde deze app niet, maar de alias noemde deze NAAM niet — '
        + 'en een niet-genoemde naam in een gekozen lijst is een weigering');
    // `tix_close` claimt alleen de eigenaar, en die heeft geen entry: de
    // geen-migratie-regel blijft daar gewoon gelden.
    assert.strictEqual(P.isToolAllowed('tix_close', cfg), true);
    // En een grant op de ene app zegt nog steeds niets over een andere.
    assert.strictEqual(P.isToolAllowed('gmail_search', cfg), true);
});

test('"deze app helemaal uitgevinkt" op de alias houdt de gedeelde namen tegen', () => {
    const cfg = { 'tickets-readonly': { actions: [] } };
    assert.strictEqual(P.isToolAllowed('tix_list', cfg), false);
    assert.strictEqual(P.isToolAllowed('tix_read', cfg), false);
    assert.strictEqual(P.isToolAllowed('tix_close', cfg), true, 'niet gedeeld, dus niet geraakt');
});

test('elke claimende app moet toestaan — de smalste wint', () => {
    const cfg = {
        tickets: { actions: ['tix_list', 'tix_read'] },
        'tickets-readonly': { actions: ['tix_read'] },
    };
    assert.strictEqual(P.isToolAllowed('tix_read', cfg), true, 'allebei ja');
    assert.strictEqual(P.isToolAllowed('tix_list', cfg), false, 'de alias zei nee');
    assert.strictEqual(P.isToolAllowed('tix_close', cfg), false, 'de eigenaar zei nee');
});

test('de gedeelde regel verbreedt nooit — een weigering blijft een weigering', () => {
    // De alias staat wagenwijd open, de eigenaar heeft alles uitgevinkt. Een
    // "of"-lezing zou hier de weigering van de eigenaar wegpoetsen.
    const cfg = { tickets: { actions: [] }, 'tickets-readonly': { actions: '*' } };
    assert.strictEqual(P.isToolAllowed('tix_list', cfg), false);
    assert.strictEqual(P.isToolAllowed('tix_read', cfg), false);

    // En andersom: `'*'` op allebei is precies wat de kiezer wegschrijft als
    // alles aanstaat, en dat mag niets afnemen.
    const open = { tickets: { actions: '*' }, 'tickets-readonly': { actions: '*' } };
    for (const n of ['tix_list', 'tix_read', 'tix_close']) {
        assert.strictEqual(P.isToolAllowed(n, open), true, n);
    }
});

test('een MCP-tool met dezelfde naam erft de grant van het registry NIET', () => {
    // Een MCP-server of custom-integratie draagt zijn eigen id op de definitie
    // (`appIdForToolDef`) en wordt nooit op naam toegeschreven. Zou een
    // naamsgelijkenis hem alsnog onder de grant van `tickets-readonly` trekken,
    // dan wordt een grant toegepast op iets waar hij niet over gaat — de fout
    // van deze bevinding, in spiegelbeeld.
    const cfg = { 'tickets-readonly': { actions: [] } };
    const mcpTool = { function: { name: 'tix_read' }, _mcp: { serverId: 'srv' } };
    assert.strictEqual(P.appIdForToolDef(mcpTool), 'mcp:srv');
    assert.strictEqual(P.isToolAllowed(mcpTool, cfg), true,
        'de map noemt mcp:srv niet, en dat is de app die deze tool bezit');
    // De registry-tool met diezelfde naam blijft wél geweigerd.
    assert.strictEqual(P.isToolAllowed('tix_read', cfg), false);
});

test('een agent zonder grants-map merkt niets van het delen', () => {
    for (const n of ['tix_list', 'tix_read', 'tix_close']) {
        assert.strictEqual(P.isToolAllowed(n, null), true, n);
    }
});

// ── Bevestigen ──────────────────────────────────────────────────────

test('confirm: een "ask" op welke claimende app dan ook wint', () => {
    // `tix_*` staat in geen sideEffectMap-lijst, dus effect = 'writes' en de
    // opgeslagen keuze telt (bij 'reads' is er niets te bevestigen en bij
    // 'sends' is 'ask' toch al verplicht).
    const cfg = {
        tickets: { actions: '*', confirm: 'direct' },
        'tickets-readonly': { actions: '*', confirm: 'ask' },
    };
    assert.strictEqual(P.confirmForTool('tix_read', cfg), 'ask',
        'de eigenaar mag de bevestiging die op de andere rij is gekozen niet wegdrukken');
    assert.strictEqual(P.confirmForTool('tix_close', cfg), 'direct',
        'niet gedeeld: alleen de eigenaar beslist');

    // En de omgekeerde volgorde geeft hetzelfde antwoord.
    const flipped = {
        tickets: { actions: '*', confirm: 'ask' },
        'tickets-readonly': { actions: '*', confirm: 'direct' },
    };
    assert.strictEqual(P.confirmForTool('tix_read', flipped), 'ask');
});

test('confirm blijft de opt-in-grens respecteren', () => {
    assert.strictEqual(P.confirmForTool('tix_read', null), 'direct',
        'zonder grants-map wordt de registry niet eens aangeraakt');
    assert.strictEqual(P.confirmForTool('tix_read', { tickets: { actions: '*' } }), 'direct',
        'niemand koos iets ⇒ de legacy-default');
});

// ── Identiteit: één credential, één antwoord ────────────────────────

test('normalisatie weigert "als de eigenaar" op een app die zijn grants elders laat lopen', () => {
    LENDING_ON = true;
    const { tools, warnings } = P.normaliseToolsConfig(
        { tools: { 'tickets-readonly': { actions: ['tix_read'], actAs: 'owner' } } },
        { lentProviders: new Set(['ticketing']) },
    );
    assert.strictEqual(tools['tickets-readonly'].actAs, 'viewer',
        'de identiteitsvraag hoort bij de app die de namen bezit — hier opslaan '
        + 'levert een veld op dat niets stuurt, en dat is precies wat verboden is');
    assert.ok(warnings.some(w => w.includes('tickets-readonly')), 'en het wordt hardop gezegd');
    LENDING_ON = false;
});

test('de eigenaar mag "als de eigenaar" wél opslaan, en dat blijft leenbaar', () => {
    LENDING_ON = true;
    const { tools } = P.normaliseToolsConfig(
        { tools: { tickets: { actions: ['tix_read'], actAs: 'owner' } } },
        { lentProviders: new Set(['ticketing']) },
    );
    assert.strictEqual(tools.tickets.actAs, 'owner');
    assert.strictEqual(P.mayLendOwnerConnection('tix_read', { tools }), true,
        'een gedeelde naam leent op de verbinding van de app die hem bezit');
    LENDING_ON = false;
});

// ── De vangregel die de declaratie zelf geen fail-open laat worden ───

test('een naam die ALLEEN een uitstellende app levert krijgt tóch een eigenaar', () => {
    // De regel `if (!byTool.has(name) && ids.length) byTool.set(name, ids[0])`
    // had nul dekking: hem weghalen liet elke test groen. En hij bewaakt een
    // ECHTE fail-open — ontbreekt de eigenaar in het registry (of laadt zijn
    // module niet), dan zet een uitstellende app `byTool` nooit, en dan is de
    // gedeelde naam ONGEATTRIBUEERD: de lezing die voor `set_reminder` bedoeld
    // is en die elke per-app-grant passeert.
    setRegistry([OTHER_ENTRY, ALIAS_ENTRY]);          // eigenaar ontbreekt

    assert.strictEqual(P.isAttributionAvailable(), true, 'de index is verder gezond');
    assert.strictEqual(P.appIdForTool('tix_list'), 'tickets-readonly',
        'de eerste claimende app wordt de eigenaar — nooit "niemand"');

    const uitgevinkt = { 'tickets-readonly': { actions: [] } };
    assert.ok(!P.isToolAllowed('tix_list', uitgevinkt), '"ik heb deze app helemaal uitgevinkt" telt');
    assert.ok(!P.isToolAllowed('tix_read', uitgevinkt));
    assert.strictEqual(P.mayLendOwnerConnection('tix_list', { tools: uitgevinkt }), false,
        'en er wordt niets geleend op een grant die niets gunt');
});

test('een eigenaar wiens MODULE niet laadt degradeert de index — hij verdwijnt niet stil', () => {
    // De andere helft van dezelfde wond: `loadTools` gooit nooit, dus een
    // module die niet laadt kwam vroeger binnen als "deze app heeft geen
    // namen". Dan neemt de vangregel hierboven de alias als eigenaar en lijkt
    // alles gezond, terwijl de helft van de namen (tix_close) verdwenen is.
    LOAD_FAILS_FOR.add('tickets');
    setRegistry([OTHER_ENTRY, OWNER_ENTRY, ALIAS_ENTRY]);
    try {
        assert.strictEqual(P.isAttributionAvailable(), false,
            'incompleet is geen feit — de index moet toegeven dat hij het niet weet');
        assert.ok(!P.isToolAllowed('tix_close', { gmail: { actions: ['gmail_search'] } }),
            'een naam die alleen de onleesbare app bezit is ongeattribueerd, en dan weigert de '
            + 'degraded tak hem — vroeger leverde precies dit de hele app terug');
        // `tix_list` wordt nog wel geattribueerd (de alias levert hem), en daar
        // beslist de gewone grant-regel. In het product kan die splitsing niet
        // ontstaan: eigenaar en alias laden DEZELFDE module, dus ze vallen
        // samen uit — en dan is elke naam van het paar ongeattribueerd.
        assert.strictEqual(P.appIdForTool('tix_list'), 'tickets-readonly');
    } finally {
        LOAD_FAILS_FOR.delete('tickets');
        setRegistry([OTHER_ENTRY, OWNER_ENTRY, ALIAS_ENTRY]);
    }
});

test('lentAppsFor slaat de uitstellende app over — de kaart mag hem niet aanbieden', () => {
    // `normaliseToolsConfig` weigert `actAs: 'owner'` op een app die zijn
    // grants elders laat lopen (de test hierboven), dus hem in de leenlijst
    // zetten liet het scherm een keuze aanbieden die de opslag terugdraait —
    // en `ownerRefused` vuurde niet eens, want de kaart dacht dat het mocht.
    const apps = P.lentAppsFor(new Set(['ticketing']));
    assert.deepStrictEqual(apps, ['tickets'],
        'alleen de app die de namen bezit; de rij die ze uitleent hoort er niet in');
});

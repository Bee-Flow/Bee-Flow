/**
 * Two registry entries, ONE set of tool names (A2-4).
 *
 * ── THE FINDING ─────────────────────────────────────────────────────
 * `outlook` and `outlook-readonly` are both in the registry and load the same module; the read-only variant is a
 * strict SUBSET of the same three names on the same credentials. The attribution index assigned a name to the FIRST
 * entry that mentioned it, so `outlook` owned `outlook_search`, `outlook_read` and `outlook_list_recent` and
 * `outlook-readonly` owned none of them.
 *
 * Consequence: a grant that was stored on `outlook-readonly` — the picker shows it as its own app with three actions,
 * so it is storable — governed NOTHING. `isToolAllowed` resolved the name to `outlook`, found no entry there and read
 * that as "every action". Even `{actions: []}` — "I have unticked this app entirely" — held nothing back. Exactly what the
 * module header forbids: every field here is enforced, or it is not stored.
 *
 * ── THE RULE THAT CLOSES IT ─────────────────────────────────────────
 * If more than one app claims the same tool name, then EVERY claiming app must allow that name. That is the narrowest
 * reading and therefore the only one that never widens: a missing entry remains "every action of this app" (the
 * no-migration rule), and an entry that does not name the tool is a refusal that stays in force.
 *
 * The OWNER of a shared name follows a declaration (`grantsVia` in automation/toolRegistry.js) and not the order of the
 * list. Who is the owner determines where the identity question (`actAs`) is answered — one credential, one answer —
 * and that may not flip because someone swaps two lines in the registry.
 *
 * Fake apps, not real ones: what is pinned here is the SHAPE, not which integrations ride along this week. That the real
 * registry keeps to the shape is guarded by automation/toolRegistry.test.js.
 *
 * Run: node --test --test-force-exit core/agentRuntime/toolPolicy.sharedModule.test.js
 */

require('../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
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
        // As in the real source: a module that does not load gives not an exception but `ok: false` — the difference between
        // "this app has no tools" and "I could not read this app".
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

    // The same two entries, reversed. Under "the first wins" the ownership moved here to the alias — and with it the place
    // where `actAs` is read — while nobody moved a grant.
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
    // `tix_close` claims only the owner, and that one has no entry: the no-migration rule still applies there.
    assert.strictEqual(P.isToolAllowed('tix_close', cfg), true);
    // And a grant on one app still says nothing about another.
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
    // The alias is wide open, the owner has unticked everything. An "or" reading would here wipe out the owner's refusal.
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
    // An MCP server or custom integration carries its own id on the definition (`appIdForToolDef`) and is never assigned by
    // name. If a name resemblance nevertheless pulled it under the grant of `tickets-readonly`, a grant would be applied to
    // something it does not concern — the fault of this finding, in mirror image.
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

// ── The catch-all rule that stops the declaration itself from becoming fail-open ───

test('een naam die ALLEEN een uitstellende app levert krijgt tóch een eigenaar', () => {
    // The rule `if (!byTool.has(name) && ids.length) byTool.set(name, ids[0])` had zero coverage: removing it left every test
    // green. And it guards a REAL fail-open — if the owner is missing from the registry (or its module does not load), then a
    // deferring app never sets `byTool`, and then the shared name is UNATTRIBUTED: the reading that is meant for `set_reminder`
    // and that every per-app grant passes.
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
    // The other half of the same wound: `loadTools` never throws, so a module that did not load came in as "this app has no
    // names". Then the catch-all rule above takes the alias as owner and everything looks healthy, while half of the names
    // (tix_close) have disappeared.
    LOAD_FAILS_FOR.add('tickets');
    setRegistry([OTHER_ENTRY, OWNER_ENTRY, ALIAS_ENTRY]);
    try {
        assert.strictEqual(P.isAttributionAvailable(), false,
            'incompleet is geen feit — de index moet toegeven dat hij het niet weet');
        assert.ok(!P.isToolAllowed('tix_close', { gmail: { actions: ['gmail_search'] } }),
            'een naam die alleen de onleesbare app bezit is ongeattribueerd, en dan weigert de '
            + 'degraded tak hem — vroeger leverde precies dit de hele app terug');
        // `tix_list` is still attributed (the alias supplies it), and there the ordinary grant rule decides. In the product this
        // split cannot arise: owner and alias load the SAME module, so they fall away together — and then every name of the pair
        // is unattributed.
        assert.strictEqual(P.appIdForTool('tix_list'), 'tickets-readonly');
    } finally {
        LOAD_FAILS_FOR.delete('tickets');
        setRegistry([OTHER_ENTRY, OWNER_ENTRY, ALIAS_ENTRY]);
    }
});

test('lentAppsFor slaat de uitstellende app over — de kaart mag hem niet aanbieden', () => {
    // `normaliseToolsConfig` refuses `actAs: 'owner'` on an app that lets its grants run elsewhere (the test above), so putting
    // it on the lending list let the screen offer a choice that the storage rolls back — and `ownerRefused` did not even fire,
    // because the card thought it was allowed.
    const apps = P.lentAppsFor(new Set(['ticketing']));
    assert.deepStrictEqual(apps, ['tickets'],
        'alleen de app die de namen bezit; de rij die ze uitleent hoort er niet in');
});

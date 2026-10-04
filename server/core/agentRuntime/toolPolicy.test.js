/**
 * Unit tests for the agent tool policy.
 *
 * Run: node --test --test-force-exit core/agentRuntime/toolPolicy.test.js
 *
 * The registry index is stubbed via require.cache so the assertions describe a
 * SHAPE rather than whichever integrations happen to ship this week.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..');

// ── Stub the tool registry the app index is built from ──────────────
const registryPath = require.resolve(path.join(SERVER, 'automation/toolRegistry'));
// Flipped by the degraded-attribution tests below: `_buildAppIndex` reads
// TOOL_REGISTRY through this getter, so throwing here is exactly the
// "registry hiccup" the runtime has to survive without granting anything.
let REGISTRY_BROKEN = false;
require.cache[registryPath] = {
    id: registryPath, filename: registryPath, loaded: true,
    exports: {
        get TOOL_REGISTRY() {
            if (REGISTRY_BROKEN) throw new Error('tool registry unavailable');
            return REGISTRY_ENTRIES;
        },
        get INLINE_TOOL_APPS() {
            if (REGISTRY_BROKEN) throw new Error('tool registry unavailable');
            return INLINE_ENTRIES;
        },
        get ALL_TOOL_APPS() {
            if (REGISTRY_BROKEN) throw new Error('tool registry unavailable');
            return [...REGISTRY_ENTRIES, ...INLINE_ENTRIES];
        },
        loadTools: (entry) => TOOLS_BY_APP[entry.app] || [],
        // Zoals de ECHTE bron: `loadTools` gooit nooit, en de storing komt als
        // WAARDE terug. Een app in `LOAD_FAILS_FOR` laadt niet — dat is iets
        // anders dan een app zonder tools, en de index hoort dat verschil te
        // zien (zonder deze functie kon hij het niet).
        loadToolsResult: (entry) => (LOAD_FAILS_FOR.has(entry.app)
            ? { tools: [], ok: false, reason: 'require_failed' }
            : { tools: TOOLS_BY_APP[entry.app] || [], ok: true, reason: null }),
    },
};
const TOOLS_BY_APP = {
    gmail: [
        { function: { name: 'gmail_search' } },
        { function: { name: 'gmail_compose' } },
        { function: { name: 'gmail_create_draft' } },
    ],
    'google-drive': [
        { function: { name: 'drive_search' } },
        { function: { name: 'drive_upload_file' } },
    ],
    'kb-search': [{ function: { name: 'kb_search' } }],
    'browser-fetch': [{ function: { name: 'browse_web' } }],
};
/** Apps waarvan de module NIET laadt — de vorm die de echte bron produceert. */
const LOAD_FAILS_FOR = new Set();

const REGISTRY_ENTRIES = [
    { app: 'gmail', label: 'Gmail' },
    { app: 'google-drive', label: 'Google Drive' },
    { app: 'kb-search', label: 'Knowledge Base' },
];
// Een app die zijn tools INLINE injecteert (achter een docker-probe, een
// adminvlag, een entitlement) en dus tot nu toe in geen enkele lijst stond die
// de kiezer leest. `grantsRequireEntry` is wat dat gat dichttrekt.
const INLINE_ENTRIES = [
    { app: 'browser-fetch', label: 'Browse Web', grantsRequireEntry: true, availability: 'installation' },
];

// Lending is resolved through this module; keep it inert and cheap.
const crPath = require.resolve(path.join(SERVER, 'core/integrations/connectionResolution'));
let LENDING_ON = false;
require.cache[crPath] = {
    id: crPath, filename: crPath, loaded: true,
    exports: {
        isLendingEnabled: () => LENDING_ON,
        providerForTool: (n) => (String(n).startsWith('gmail_') || String(n).startsWith('drive_') ? 'google' : null),
    },
};

const P = require('./toolPolicy');

test('appIdForTool maps a tool name back to the app that owns it', () => {
    assert.strictEqual(P.appIdForTool('gmail_compose'), 'gmail');
    assert.strictEqual(P.appIdForTool('drive_search'), 'google-drive');
    // Unattributed names are not an error — a grant keyed on an app has
    // nothing to say about a built-in.
    assert.strictEqual(P.appIdForTool('set_reminder'), null);
    assert.strictEqual(P.appIdForTool(''), null);
    assert.strictEqual(P.appIdForTool(null), null);
});

test('appIdForToolDef sees MCP and custom integrations the registry cannot', () => {
    assert.strictEqual(
        P.appIdForToolDef({ function: { name: 'anything' }, _mcp: { serverId: 'tuya' } }),
        'mcp:tuya',
    );
    assert.strictEqual(
        P.appIdForToolDef({ function: { name: 'anything' }, _custom: { integrationId: 'abc' } }),
        'custom:abc',
    );
    assert.strictEqual(P.appIdForToolDef({ function: { name: 'gmail_search' } }), 'gmail');
});

test('a missing entry or "*" grants every action — no migration', () => {
    assert.strictEqual(P.allowedToolsFor('gmail', null), null);
    assert.strictEqual(P.allowedToolsFor('gmail', {}), null);
    assert.strictEqual(P.allowedToolsFor('gmail', { gmail: { actions: '*' } }), null);
    assert.strictEqual(P.allowedToolsFor('gmail', { gmail: {} }), null);
    assert.ok(P.isToolAllowed('gmail_compose', { gmail: { actions: '*' } }));
    assert.ok(P.isToolAllowed('gmail_compose', {}));
});

test('an explicit list narrows to exactly those actions; an empty list grants none', () => {
    const cfg = { gmail: { actions: ['gmail_search'] } };
    assert.ok(P.isToolAllowed('gmail_search', cfg));
    assert.ok(!P.isToolAllowed('gmail_compose', cfg));
    // Untick everything and it must STAY unticked, or the round trip
    // silently re-grants the whole app.
    const none = { gmail: { actions: [] } };
    assert.strictEqual(P.allowedToolsFor('gmail', none).size, 0);
    assert.ok(!P.isToolAllowed('gmail_search', none));
    // A different app is untouched by gmail's list.
    assert.ok(P.isToolAllowed('drive_search', cfg));
    // As is a tool nobody claims.
    assert.ok(P.isToolAllowed('set_reminder', cfg));
});

// ── Apps de kiezer nooit kon tonen (A2-1) ───────────────────────────
// `browse_web` wordt INLINE geregistreerd, achter een docker-probe. Hij stond
// daardoor in geen enkele lijst die de kiezer leest, en gleed als "niemand
// claimt deze naam" langs isToolAllowed — ook bij een agent die tot één
// Gmail-actie was versmald. De doorlaat voor niet-toe-te-schrijven namen
// bestaat voor `set_reminder` en voor MCP/custom-tools die hun eigen id
// dragen; hij bestaat niet voor een app die er gewoon is.

test('browse_web is een APP-tool, geen naamloze — de kiezer en de runtime kennen hem allebei', () => {
    assert.strictEqual(P.appIdForTool('browse_web'), 'browser-fetch');
    assert.deepStrictEqual(P.actionsOfApp('browser-fetch'), ['browse_web']);
});

test('een agent gecureerd tot één Gmail-actie krijgt GEEN browser', () => {
    const curated = { gmail: { actions: ['gmail_search'] } };
    assert.ok(P.isToolAllowed('gmail_search', curated), 'de gekozen actie blijft');
    assert.ok(!P.isToolAllowed('browse_web', curated),
        'zwijgen over een app die de kiezer nooit toonde is geen keuze om te respecteren');
    // De naamloze tools blijven door de doorlaat gaan: een grant op een app
    // zegt niets over `set_reminder`, en MCP/custom dragen hun eigen id.
    assert.ok(P.isToolAllowed('set_reminder', curated));
    assert.ok(P.isToolAllowed(
        { function: { name: 'tuya_list_devices' }, _mcp: { serverId: 'tuya' } }, curated,
    ));
    // En de geen-migratie-regel blijft staan voor apps die de kiezer WEL altijd
    // toonde: over Drive is niets gezegd, dus Drive houdt zijn toolbelt.
    assert.ok(P.isToolAllowed('drive_search', curated));
    assert.ok(P.isToolAllowed('drive_upload_file', curated));
});

test('een inline app die de eigenaar WEL koos werkt gewoon, en versmalt gewoon', () => {
    assert.ok(P.isToolAllowed('browse_web', { 'browser-fetch': { actions: '*' } }),
        'een UITGESCHREVEN "alles" is een keuze en telt');
    assert.ok(P.isToolAllowed('browse_web', { 'browser-fetch': { actions: ['browse_web'] } }));
    assert.ok(!P.isToolAllowed('browse_web', { 'browser-fetch': { actions: [] } }),
        'uitvinken moet een rondreis overleven');
});

test('een entry ZONDER actielijst gunt een inline app niets — de kaart schrijft die entries', () => {
    // Dit was gepind als gewenst gedrag ("een entry zonder actielijst is nog
    // steeds een genoemde app — dat is de hele app") en dat is in het product
    // onwaar: de Tools-kaart zet zulke entries neer bij twee VERSMALLENDE
    // gebaren. `setAppConfirm` schrijft `{confirm}` en `setAppActAs` schrijft
    // `{actAs}`, allebei zonder `actions` — en dan gaf deze laag een volledige
    // headless browser aan een agent die tot `gmail_search` was gecureerd.
    const curated = { gmail: { actions: ['gmail_search'] } };
    for (const entry of [{}, { confirm: 'ask' }, { actAs: 'viewer' }, { actions: null }]) {
        const cfg = { ...curated, 'browser-fetch': entry };
        assert.ok(!P.isToolAllowed('browse_web', cfg),
            `een entry zonder uitgeschreven acties (${JSON.stringify(entry)}) is geen ja`);
    }
    // En de gewone apps merken er niets van: daar is zwijgen wél een keuze,
    // want de kiezer heeft ze altijd kunnen tonen.
    assert.ok(P.isToolAllowed('drive_search', { ...curated, 'google-drive': { confirm: 'ask' } }));
});

test('normalisatie schrijft de verbreding niet de RIJ in', () => {
    // `applyConfigValidation` schrijft de geklemde map terug, dus wat hier
    // uitkomt is wat er blijft staan. Een ontbrekende actiesleutel mag daar
    // geen `'*'` worden: dat maakt van "de eigenaar zei niets" een
    // uitgeschreven "de eigenaar gaf alles".
    const { tools } = P.normaliseToolsConfig({
        tools: { gmail: { actions: ['gmail_search'] }, 'browser-fetch': { confirm: 'ask' } },
    });
    assert.ok(!('actions' in tools['browser-fetch']),
        'geen actiesleutel erbij verzinnen — ook geen "*"');
    assert.ok(!P.isToolAllowed('browse_web', tools), 'en de rij blijft dus een weigering');
});

test('een agent die NIEMAND cureerde houdt zijn browser — dit is geen stille migratie', () => {
    for (const cfg of [null, {}, { gmail: 'nope' }, { automations: {} }]) {
        assert.ok(P.isToolAllowed('browse_web', cfg),
            'geen curatie betekent dat de rechtenlaag niet eens meekijkt');
    }
    // Een LEGE gereserveerde sectie is geen curatie (hasCuratedGrants), maar
    // een gevulde wel — en dan telt de regel ook voor de inline app.
    assert.ok(!P.isToolAllowed('browse_web', { automations: { a1: {} } }));
});

test('an unnameable tool definition is never offered', () => {
    assert.ok(!P.isToolAllowed({ function: {} }, { gmail: { actions: '*' } }));
    assert.ok(!P.isToolAllowed(null, { gmail: { actions: '*' } }));
});

test('confirm: reads direct, sends always ask, writes follow the entry', () => {
    assert.strictEqual(P.confirmForTool('gmail_search', null), 'direct');
    // A stored "direct" cannot buy its way past a send.
    assert.strictEqual(P.confirmForTool('gmail_compose', { gmail: { confirm: 'direct' } }), 'ask');
    // A write with no entry keeps today's behaviour.
    assert.strictEqual(P.confirmForTool('drive_upload_file', null), 'direct');
    assert.strictEqual(P.confirmForTool('drive_upload_file', { 'google-drive': { confirm: 'ask' } }), 'ask');
    // ...unless the caller says the fleet default changed.
    assert.strictEqual(P.confirmForTool('drive_upload_file', null, { legacyDefault: 'ask' }), 'ask');
    // A read is never asked about, whatever the app entry says.
    assert.strictEqual(P.confirmForTool('gmail_search', { gmail: { confirm: 'ask' } }), 'direct');
});

test('normalise: a send action cannot be stored as direct', async () => {
    const { tools, warnings, changed } = P.normaliseToolsConfig({
        tools: { gmail: { actions: ['gmail_compose'], confirm: 'direct' } },
    });
    assert.strictEqual(tools.gmail.confirm, 'ask');
    assert.ok(changed);
    assert.ok(warnings.some(w => /forced to "ask"/.test(w)));
});

test('normalise: unknown action names are dropped for a known app, kept for an unknown one', () => {
    const { tools, warnings } = P.normaliseToolsConfig({
        tools: {
            gmail: { actions: ['gmail_search', 'gmail_nonsense', 'gmail_search'] },
            'mcp:tuya': { actions: ['mcp_tuya_list_devices'] },
        },
    });
    assert.deepStrictEqual(tools.gmail.actions, ['gmail_search']);
    assert.ok(warnings.some(w => /gmail_nonsense/.test(w)));
    // An app the registry does not carry has no catalogue to check against;
    // deleting the user's pick on a guess would be worse than an inert entry.
    assert.deepStrictEqual(tools['mcp:tuya'].actions, ['mcp_tuya_list_devices']);
});

test('normalise: actAs owner is downgraded without a lend grant, and always on sends', async () => {
    // No lending at all.
    let out = P.normaliseToolsConfig({ tools: { 'google-drive': { actions: '*', actAs: 'owner' } } });
    assert.strictEqual(out.tools['google-drive'].actAs, 'viewer');
    assert.ok(out.warnings.some(w => /no lent connection/.test(w)));

    // Lending on, grant present → owner survives.
    out = P.normaliseToolsConfig(
        { tools: { 'google-drive': { actions: ['drive_search'], actAs: 'owner' } } },
        { lentProviders: new Set(['google']) },
    );
    assert.strictEqual(out.tools['google-drive'].actAs, 'owner');

    // ...but never for an action that sends, grant or no grant.
    out = P.normaliseToolsConfig(
        { tools: { gmail: { actions: ['gmail_compose'], actAs: 'owner' } } },
        { lentProviders: new Set(['google']) },
    );
    assert.strictEqual(out.tools.gmail.actAs, 'viewer');
    assert.ok(out.warnings.some(w => /refused for actions that send/.test(w)));
});

test('normalise: junk never throws and never widens', () => {
    for (const junk of [null, undefined, 42, 'nope', { tools: 'nope' }, { tools: [] }]) {
        const out = P.normaliseToolsConfig(junk);
        assert.strictEqual(out.tools, null);
        assert.strictEqual(out.changed, false);
    }
    const out = P.normaliseToolsConfig({ tools: { gmail: 'nope', 'google-drive': { actions: 7 } } });
    assert.deepStrictEqual(out.tools['google-drive'].actions, [],
        'an unreadable actions value grants NOTHING — this line used to read "*", i.e. the whole app');
    // And the entry that is not an object at all takes the SAME reading. This
    // line used to assert the opposite (`!('gmail' in out.tools)`, "a
    // non-object entry is dropped") — which was the one branch in this
    // function that made a grant bigger: a dropped entry reads as "every
    // action of this app" to every reader here.
    assert.ok('gmail' in out.tools,
        'an unreadable entry stays IN the map — dropping it is what handed the whole app back');
    assert.deepStrictEqual(out.tools.gmail.actions, [], 'and it grants nothing');
    assert.ok(!P.isToolAllowed('gmail_compose', out.tools),
        'the clamped map, which is the one that gets persisted, may not grant more than the raw one');
    assert.ok(out.warnings.some(w => /gmail/.test(w) && /no actions granted/.test(w)),
        'said out loud, so the owner re-picks instead of silently getting more than they asked for');
});

// The same widening, measured against the RAW map rather than against a
// remembered string. Every unreadable app-entry shape a client can send: the
// narrow reading is the only one allowed, and "narrow" is defined as "no more
// than what the map as sent already granted".
test('normalise: no unreadable app entry may come back wider than it was sent', () => {
    for (const junk of ['nope', 42, true, [], ['gmail_search'], null]) {
        const raw = { gmail: junk };
        const out = P.normaliseToolsConfig({ tools: raw });
        // `null` is the one shape that legitimately means "the whole app" —
        // it is what `{gmail: {}}` normalises through — so it is measured the
        // same way as the rest instead of being special-cased here.
        for (const name of ['gmail_search', 'gmail_compose', 'gmail_create_draft']) {
            if (P.isToolAllowed(name, out.tools)) {
                assert.ok(P.isToolAllowed(name, raw),
                    `normalising {gmail: ${JSON.stringify(junk)}} granted ${name}, which the raw map did not`);
            }
        }
    }
});

// ── Unreadable input may not widen ──────────────────────────────────
// The exact shape a legacy client sends when it means one action: a bare
// string where a list belongs. It used to come back as `'*'` — every action of
// the app — and `applyConfigValidation` then wrote that into the row on the
// next PUT, so a typo permanently GREW the agent's toolbelt.

test('normalise: a bare string where a list belongs grants nothing, never everything', () => {
    const out = P.normaliseToolsConfig({ tools: { gmail: { actions: 'gmail_search' } } });

    assert.notStrictEqual(out.tools.gmail.actions, '*',
        'unreadable is not a request for the whole app');
    assert.deepStrictEqual(out.tools.gmail.actions, [], 'unreadable ⇒ no action granted');
    assert.ok(out.warnings.some(w => /gmail/.test(w) && /no actions granted/.test(w)),
        'and the owner is told, so they re-pick instead of silently getting less — or more');

    // The enforcement layer agrees: nothing of this app is offered.
    assert.ok(!P.isToolAllowed('gmail_search', out.tools));
    assert.ok(!P.isToolAllowed('gmail_compose', out.tools));
    // A second app is untouched by one unreadable entry.
    assert.ok(P.isToolAllowed('drive_search', out.tools));
});

// The same widening through the other door: the SIZE bound. Truncating the
// app list dropped the surplus entries, and a dropped entry is not a smaller
// grant — a missing entry means "every action of this app". So the narrow
// grant on app 201 came back as the whole app, and `applyConfigValidation`
// wrote that into the row.

test('normalise: past the app bound the surplus apps grant nothing, not everything', () => {
    const raw = {};
    for (let i = 0; i < P.MAX_APP_ENTRIES; i++) raw[`filler_${i}`] = { actions: [] };
    raw.gmail = { actions: ['gmail_search'] };          // entry #201: the real grant

    // Precondition: as SENT, this map is narrow.
    assert.ok(!P.isToolAllowed('gmail_compose', raw));

    const out = P.normaliseToolsConfig({ tools: raw });
    assert.ok('gmail' in out.tools,
        'the surplus app is still IN the map — leaving it out is what opened it up');
    assert.deepStrictEqual(out.tools.gmail.actions, [],
        'past the bound is "no actions granted", the narrow reading — never the whole app');
    assert.ok(!P.isToolAllowed('gmail_compose', out.tools),
        'and the clamped map, which is the one that gets persisted, may not grant more than the raw one');
    assert.ok(!P.isToolAllowed('gmail_search', out.tools),
        'including the action that WAS picked: dropping it is a loss the owner is told about, ' +
        'granting the rest is one they would never see');
    assert.ok(out.warnings.some(w => new RegExp(String(P.MAX_APP_ENTRIES)).test(w)),
        'said out loud, so the owner can prune the map instead of wondering');

    // The bound still bounds: nothing past it costs a registry lookup or an
    // effect scan, it is just spelled out instead of vanishing.
    assert.strictEqual(Object.keys(out.tools).length, P.MAX_APP_ENTRIES + 1);
});

// ── The datatable section, stored because it is now enforced ────────
// It was REFUSED for two releases: shaped, never wired, and clamping it to a
// tidy `{scope:'own'}` made it look enforced — the worst of both, because the
// owner reads it back and believes it. `core/tools/datatableTools.js` enforces
// both halves now (the tool is only offered for a granted table, and every
// call re-reads scope + columns before compiling), so it is stored — clamped
// the same narrow way every other section here is.

test('normalise: a datatable grant is stored, with every unreadable half narrowed', () => {
    const out = P.normaliseToolsConfig({
        tools: { datatables: { t1: { scope: 'everything', columns: ['a', 7, 'b'] }, t2: {} } },
    });

    assert.strictEqual(out.tools.datatables.t1.scope, 'own',
        'an access question nobody can read lands on the narrow side — never "all"');
    assert.deepStrictEqual(out.tools.datatables.t1.columns, ['a', 'b'], 'junk entries drop out of the list');
    assert.deepStrictEqual(out.tools.datatables.t2, { scope: 'own', columns: '*' },
        'an empty grant is "this table, its own rows, every column" — picking the table meant its contents');
    assert.ok(out.warnings.some(w => /datatables\.t1/.test(w) && /scope/.test(w)),
        'and the owner hears which half was refused');
});

test('normalise: an unreadable datatable grant keeps the id and grants nothing readable', () => {
    // The ID is the half that IS readable and the owner deliberately picked it,
    // so the grant survives — narrowed to its own rows and to no columns, which
    // `datatable_query` refuses out loud. Same rule as the automations branch:
    // only the unreadable half is decided against the caller.
    const out = P.normaliseToolsConfig({ tools: { datatables: { t1: 'nonsense', t2: { columns: 'naam' } } } });

    assert.deepStrictEqual(out.tools.datatables.t1, { scope: 'own', columns: [] });
    assert.deepStrictEqual(out.tools.datatables.t2.columns, [],
        'a bare string is not a request for the whole table — that is the widening `actions` was fixed for');
    assert.ok(out.warnings.length >= 2);
});

test('normalise: the datatable section is bounded, and truncating it NARROWS', () => {
    // Unlike the app overflow, which has to spell out `{actions: []}` because a
    // MISSING app entry means every action: a missing datatable entry means the
    // table is not granted at all, so dropping one can only take access away.
    const many = {};
    for (let i = 0; i < P.MAX_DATATABLE_GRANTS + 5; i++) many[`t${i}`] = { scope: 'all', columns: '*' };
    const out = P.normaliseToolsConfig({ tools: { datatables: many } });

    assert.strictEqual(Object.keys(out.tools.datatables).length, P.MAX_DATATABLE_GRANTS);
    assert.ok(out.warnings.some(w => new RegExp(String(P.MAX_DATATABLE_GRANTS)).test(w)));
});

test('normalise: a datatables value that is not an object is dropped', () => {
    const out = P.normaliseToolsConfig({ tools: { datatables: ['t1', 't2'] } });
    assert.ok(!('datatables' in out.tools));
    assert.ok(out.warnings.some(w => /datatables/.test(w)));
});

test('normalise: a grant keyed on __proto__ is dropped, not silently swallowed', () => {
    // JSON.parse makes `__proto__` an OWN property, so a stored config can
    // carry one; assigning it back onto a plain object REPLACES the prototype
    // instead of adding a key, and the grant then reads as absent while the
    // map itself is quietly broken. Same rule as queryCompiler.fieldMap.
    const cfg = JSON.parse('{"tools":{"datatables":{"__proto__":{"scope":"all"},"t1":{"scope":"all","columns":"*"}}}}');
    const out = P.normaliseToolsConfig(cfg);

    assert.deepStrictEqual(Object.keys(out.tools.datatables), ['t1']);
    assert.ok(out.warnings.some(w => /__proto__/.test(w)), 'and said out loud, not swallowed');
    assert.strictEqual(Object.getPrototypeOf(out.tools.datatables), Object.prototype,
        'the map is still an ordinary object every reader can iterate');

    const read = P.datatableGrantsOf(cfg.tools);
    assert.deepStrictEqual(Object.keys(read), ['t1']);
    assert.strictEqual(Object.getPrototypeOf(read), Object.prototype);
});

test('datatableGrantsOf reads exactly what normalise writes', () => {
    // Both ends normalise (module header). The read side being the WIDER of the
    // two is how a refused limit comes back to life on a row nobody re-saved.
    for (const raw of [
        { t1: { scope: 'everything', columns: ['a', 7, 'b'] } },
        { t1: 'nonsense' },
        { t1: { columns: 'naam' } },
        { t1: {} },
        { t1: { scope: 'all', columns: '*' } },
    ]) {
        const written = P.normaliseToolsConfig({ tools: { datatables: raw } }).tools.datatables;
        assert.deepStrictEqual(P.datatableGrantsOf({ datatables: raw }), written, JSON.stringify(raw));
    }
});

// An empty grant means `direct` — the automation fires the moment the model asks
// for it. So a confirm the clamp cannot read may not become an empty grant:
// that is a typo silently promoted to "sends without asking", the same
// widening the `actions` branch was fixed for.

test('normalise: an automation confirm nobody can read becomes "ask", loudly', () => {
    const out = P.normaliseToolsConfig({
        tools: {
            automations: {
                a1: { confirm: 'ask' },         // readable
                a2: {},                         // no confirm stated: today's behaviour
                a3: { confirm: 'whatever' },    // unreadable
                a4: { confirm: 'Ask' },         // the capital that used to mean "direct"
                a5: 'nope',                     // not a grant object at all
            },
        },
    });

    assert.deepStrictEqual(out.tools.automations.a1, { confirm: 'ask' });
    assert.deepStrictEqual(out.tools.automations.a2, {},
        'a grant that states no confirm is not an unreadable one — it is the picker\'s default');
    for (const id of ['a3', 'a4', 'a5']) {
        assert.deepStrictEqual(out.tools.automations[id], { confirm: 'ask' },
            `${id}: an unreadable confirm may not fall through to "runs unasked"`);
        assert.ok(out.warnings.some(w => w.includes(`automations.${id}`)),
            `${id}: refused out loud, or the owner never learns their value did not stick`);
    }
    assert.deepStrictEqual(out.warnings.filter(w => /automations\.(a1|a2)\b/.test(w)), [],
        'and the readable grants are not nagged about');

    // Second pass settles: what came back is readable, so nothing changes.
    const second = P.normaliseToolsConfig({ tools: out.tools });
    assert.deepStrictEqual(second.tools, out.tools);
    assert.deepStrictEqual(second.warnings, []);
    assert.strictEqual(second.changed, false);
});

test('normalise is idempotent — a normalised config round-trips unchanged', () => {
    const first = P.normaliseToolsConfig({
        tools: {
            gmail: { actions: ['gmail_compose'], confirm: 'direct', actAs: 'owner' },
        },
    });
    const second = P.normaliseToolsConfig({ tools: first.tools });
    assert.deepStrictEqual(second.tools, first.tools);
    assert.strictEqual(second.changed, false, 'a second pass must find nothing to change');
});

test('buildToolPolicy whitelists by name and drops ask-tools when nobody is watching', () => {
    const tools = [
        { function: { name: 'gmail_search' } },
        { function: { name: 'gmail_compose' } },
        { function: { name: 'drive_upload_file' } },
        { function: { name: 'set_reminder' } },
    ];
    // A CURATED map — an empty one is not an opt-in at all (see below).
    const curated = { tools: { gmail: { actions: '*' } } };
    const attended = P.buildToolPolicy({ agentConfig: curated, tools });
    assert.ok(attended.allowedToolNames.has('gmail_compose'));
    assert.strictEqual(attended.confirmByTool.get('gmail_compose'), 'ask');
    assert.strictEqual(attended.confirmByTool.get('gmail_search'), 'direct');
    assert.strictEqual(attended.confirmByTool.get('drive_upload_file'), 'direct');

    const headless = P.buildToolPolicy({ agentConfig: curated, tools, unattended: true });
    assert.ok(!headless.allowedToolNames.has('gmail_compose'), 'a send is not offered to a headless run');
    assert.ok(headless.allowedToolNames.has('gmail_search'));
    assert.deepStrictEqual(headless.droppedForUnattended, ['gmail_compose']);
});

// ── An empty or junk map is not the opt-in ──────────────────────────
// The regime flip is one PUT away otherwise: `normaliseToolsConfig` turns a
// malformed `tools` value into `{}`, and a map-shaped nothing that counts as
// "someone has been through the picker" makes a mailing automation stop mailing
// with nothing in the UI to explain it.

test('hasCuratedGrants asks the CONTENTS, not whether the key is there', () => {
    assert.strictEqual(P.hasCuratedGrants(null), false);
    assert.strictEqual(P.hasCuratedGrants({}), false, 'an empty map is what junk normalises to');
    assert.strictEqual(P.hasCuratedGrants({ gmail: 'nope' }), false,
        'an entry every reader drops grants nothing and asks nothing');
    assert.strictEqual(P.hasCuratedGrants({ automations: {} }), false,
        'an empty section is a section nobody filled in');
    assert.strictEqual(P.hasCuratedGrants({ gmail: {} }), true,
        'an app someone added, even with defaults, IS a choice');
    assert.strictEqual(P.hasCuratedGrants({ automations: { a1: { confirm: 'ask' } } }), true);
});

test('an empty or junk map behaves exactly like no map — attended and headless', () => {
    const tools = [{ function: { name: 'gmail_compose' } }, { function: { name: 'gmail_search' } }];
    const legacy = P.buildToolPolicy({ agentConfig: {}, tools });

    for (const [label, agentConfig] of [
        ['empty map', { tools: {} }],
        ['junk-only map', { tools: { gmail: 'nope' } }],
    ]) {
        const policy = P.buildToolPolicy({ agentConfig, tools });
        assert.deepStrictEqual([...policy.gatedTools], [...legacy.gatedTools],
            `${label}: nobody curated anything, so nothing may be held back`);
        assert.strictEqual(policy.confirmByTool.get('gmail_compose'), 'ask',
            `${label}: the VERDICT is unchanged — a send still needs a yes`);

        const headless = P.buildToolPolicy({ agentConfig, tools, unattended: true });
        assert.deepStrictEqual(headless.droppedForUnattended, [],
            `${label}: dropping the send tool here is a mailing automation that silently stops mailing`);
        assert.ok(headless.allowedToolNames.has('gmail_compose'));
    }
});

test('buildToolPolicy honours a per-automation confirm override', () => {
    const tools = [{ function: { name: 'summarise_inbox' } }, { function: { name: 'mail_the_client' } }];
    const policy = P.buildToolPolicy({
        agentConfig: {},
        tools,
        automationConfirms: new Map([['summarise_inbox', 'direct'], ['mail_the_client', 'ask']]),
    });
    assert.strictEqual(policy.confirmByTool.get('summarise_inbox'), 'direct');
    assert.strictEqual(policy.confirmByTool.get('mail_the_client'), 'ask');
    // Without the override an unknown name would fail closed to a write; the
    // override is the automation's DEFINITION-derived effect and must win.
    const headless = P.buildToolPolicy({
        agentConfig: {}, tools, unattended: true,
        automationConfirms: new Map([['summarise_inbox', 'direct'], ['mail_the_client', 'ask']]),
    });
    assert.ok(headless.allowedToolNames.has('summarise_inbox'));
    assert.ok(!headless.allowedToolNames.has('mail_the_client'));
});

test('isUnattended reads the existing headless markers, not a new flag', () => {
    assert.strictEqual(P.isUnattended({}), false);
    assert.strictEqual(P.isUnattended({ autoSend: true }), true);
    assert.strictEqual(P.isUnattended({ unattended: true }), true);
    assert.strictEqual(P.isUnattended(null), false);
});

test('automationGrantsOf is what narrows the caller-keyed automation set', () => {
    // getIntegrationTools reads this to keep only the automations the agent's
    // OWNER granted, out of every automation the person chatting happens to own.
    const grants = (config) => P.automationGrantsOf(P.toolsConfigOf(config));
    assert.deepStrictEqual(grants({}), {});
    assert.deepStrictEqual(grants({ tools: {} }), {});
    assert.deepStrictEqual(grants({ tools: { automations: {} } }), {});
    assert.deepStrictEqual(grants({ tools: { automations: 'nope' } }), {}, 'junk grants nothing');
    assert.deepStrictEqual(Object.keys(grants({ tools: { automations: { a1: {} } } })), ['a1']);
});

// ── gatedTools: the difference between a verdict and a hold-back ─────

test('gatedTools is empty without a stored map — the verdict stands, nothing is held', () => {
    const tools = [{ function: { name: 'gmail_compose' } }, { function: { name: 'drive_upload_file' } }];
    const legacy = P.buildToolPolicy({ agentConfig: { enabledIntegrations: ['gmail'] }, tools });

    assert.strictEqual(legacy.confirmByTool.get('gmail_compose'), 'ask',
        'the POLICY still says a send needs a yes');
    assert.strictEqual(legacy.gatedTools.size, 0,
        'but nothing is held back: gmail_compose confirms itself with a draft card today, and ' +
        'holding it would take that card away from every agent that predates the picker');
    assert.deepStrictEqual(legacy.droppedForUnattended, [],
        'and a mailing automation keeps the tool autoSend exists to use');
});

test('storing a map is the opt-in — the same stack is then gated', () => {
    const tools = [{ function: { name: 'gmail_compose' } }, { function: { name: 'gmail_search' } }];
    const granted = P.buildToolPolicy({ agentConfig: { tools: { gmail: { actions: '*' } } }, tools });

    assert.deepStrictEqual([...granted.gatedTools], ['gmail_compose']);
    assert.ok(!granted.gatedTools.has('gmail_search'), 'a read has nothing to approve');
});

test('an explicit per-automation confirm gates even on an agent with no app map', () => {
    const tools = [{ function: { name: 'mail_the_client' } }];
    const policy = P.buildToolPolicy({
        agentConfig: {}, tools,
        automationConfirms: new Map([['mail_the_client', 'ask']]),
    });
    assert.ok(policy.gatedTools.has('mail_the_client'),
        'the automation\'s own definition is a choice someone made, not a legacy default');
});

// ── decideToolCall ──────────────────────────────────────────────────

const policyFor = (agentConfig, names, opts = {}) => P.buildToolPolicy({
    agentConfig, tools: names.map(n => ({ function: { name: n } })), ...opts,
});

test('decideToolCall: every branch', () => {
    const legacy = policyFor({}, ['gmail_compose', 'gmail_search']);
    const granted = policyFor({ tools: { gmail: { actions: '*' } } }, ['gmail_compose', 'gmail_search']);

    // run — offered, nothing chosen about it
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_compose', policy: legacy }).action, 'run');
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_search', policy: granted }).action, 'run');

    // confirm — offered, and someone asked to be asked
    const held = P.decideToolCall({ toolName: 'gmail_compose', policy: granted });
    assert.strictEqual(held.action, 'confirm');
    assert.strictEqual(held.effect, 'sends');
    assert.strictEqual(held.confirm, 'ask');

    // refuse — never offered. This is the gate against a hallucinated or
    // injected name reaching the dispatcher's dynamic-name fallback.
    const refused = P.decideToolCall({ toolName: 'automation_pay_invoice', policy: granted });
    assert.strictEqual(refused.action, 'refuse');
    assert.strictEqual(refused.reason, 'not_offered');

    // refuse — unnameable
    assert.strictEqual(P.decideToolCall({ toolName: '', policy: granted }).action, 'refuse');
    assert.strictEqual(P.decideToolCall({ toolName: null, policy: granted }).action, 'refuse');
    assert.strictEqual(P.decideToolCall({ toolName: 42, policy: granted }).action, 'refuse');

    // a tool an unattended run withheld is not in the stack, so naming it is drift
    const headless = policyFor({ tools: { gmail: { actions: '*' } } }, ['gmail_compose'], { unattended: true });
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_compose', policy: headless }).action, 'refuse');
});

test('decideToolCall: an absent or malformed policy means "this call site does not enforce"', () => {
    // Not a fail-open grant decision — an unreadable GRANT still lands on
    // refuse/confirm inside buildToolPolicy. This is the un-instrumented call
    // site (non-streaming chat) keeping the behaviour it has.
    for (const junk of [null, undefined, {}, 42, 'nope', { allowedToolNames: ['gmail_compose'] }]) {
        const d = P.decideToolCall({ toolName: 'gmail_compose', policy: junk });
        assert.strictEqual(d.action, 'run');
        assert.strictEqual(d.reason, 'no_policy');
    }
});

// ── previewToolArgs ─────────────────────────────────────────────────

test('previewToolArgs is flat, bounded and never throws', () => {
    assert.deepStrictEqual(P.previewToolArgs({ to: 'a@b.c', count: 2, ok: true, nil: null }),
        { to: 'a@b.c', count: 2, ok: true, nil: null });
    // Nested values become a label rather than vanishing: a person still has
    // to be able to see that an argument was supplied.
    assert.deepStrictEqual(P.previewToolArgs({ cc: ['a', 'b'], body: { html: 'x' } }),
        { cc: '[2 items]', body: '{…}' });
    assert.strictEqual(P.previewToolArgs({ t: 'x'.repeat(P.PREVIEW_MAX_STRING + 50) }).t.length,
        P.PREVIEW_MAX_STRING + 1, 'long strings are cut and marked');

    const wide = {};
    for (let i = 0; i < P.PREVIEW_MAX_KEYS + 5; i++) wide[`k${i}`] = i;
    const preview = P.previewToolArgs(wide);
    assert.strictEqual(Object.keys(preview).length, P.PREVIEW_MAX_KEYS + 1);
    assert.strictEqual(preview['…'], '5 more');

    for (const junk of [null, undefined, 42, 'nope', []]) {
        assert.deepStrictEqual(P.previewToolArgs(junk), {});
    }
});

// ── Lossless over the shapes that actually occur ────────────────────

test('normalise is lossless and idempotent across every practical shape', () => {
    // One config carrying each shape the picker (and a hand-written config)
    // can produce. Nothing a person legitimately chose may disappear.
    const stored = {
        tools: {
            'gmail': { actions: ['gmail_search', 'gmail_compose'], confirm: 'ask', actAs: 'viewer' },
            'google-drive': { actions: '*', confirm: 'ask' },
            'kb-search': {},                                   // no entry fields at all
            'mcp:tuya': { actions: ['tuya_list_devices'] },    // catalogue not knowable
            'custom:abc': { actions: [] },                     // "I picked none"
            automations: { 'auto-1': { confirm: 'ask' }, 'auto-2': {} },
        },
    };

    const first = P.normaliseToolsConfig(stored);
    const t = first.tools;

    assert.deepStrictEqual(Object.keys(t).sort(), Object.keys(stored.tools).sort(), 'no key is lost');
    assert.deepStrictEqual(t.gmail.actions, ['gmail_search', 'gmail_compose']);
    assert.strictEqual(t.gmail.confirm, 'ask');
    assert.strictEqual(t['google-drive'].actions, '*', '"*" stays "*" — it is what "no migration" rests on');
    assert.ok(!('actions' in t['kb-search']),
        'an entry with no actions field KEEPS none — inventing "*" would write a choice nobody made');
    assert.ok(P.isToolAllowed('kb_search', t),
        'and for an ordinary app that absence still reads as the whole app');
    assert.deepStrictEqual(t['mcp:tuya'].actions, ['tuya_list_devices']);
    assert.deepStrictEqual(t['custom:abc'].actions, []);
    assert.deepStrictEqual(Object.keys(t.automations).sort(), ['auto-1', 'auto-2']);
    assert.strictEqual(t.automations['auto-1'].confirm, 'ask');
    assert.deepStrictEqual(first.warnings, [],
        'nothing is refused: every value here is one the picker can produce');

    // `changed` says "the stored text differs from the normalised text", not
    // "something was taken away" — the first pass writes the implicit actAs
    // out explicitly. What has to settle is the SECOND pass.
    const second = P.normaliseToolsConfig({ tools: t });
    assert.deepStrictEqual(second.tools, t, 'idempotent');
    assert.strictEqual(second.changed, false, 'or every autosave would rewrite the row');
});

test('an agent with no map normalises to no map — the shape of "unchanged behaviour"', () => {
    for (const config of [{}, { enabledIntegrations: ['gmail'] }, { tools: undefined }]) {
        const out = P.normaliseToolsConfig(config);
        assert.strictEqual(out.tools, null, 'nothing to clamp, and nothing acquired');
        assert.strictEqual(out.changed, false);
    }
});

// ── fallbackToolPolicy: what runs when buildToolPolicy itself threw ──
// The old fallback kept the name whitelist and handed back an EMPTY
// `gatedTools`. On an agent whose owner curated a `tools` map that is
// "unreadable confirm policy ⇒ dispatch anyway": the tool set to `ask` runs
// with no card, and in an unattended run — where toolStackAssembly's own catch
// has left those very tools in the stack on the same failure — the send goes
// out unapproved. A failure has to fall the other way.

const STACK = [
    { function: { name: 'gmail_search' } },
    { function: { name: 'gmail_compose' } },
    { function: { name: 'drive_upload_file' } },
    { function: { name: 'set_reminder' } },
];

test('fallback: a curated agent keeps its confirm layer when the build fails', () => {
    const curated = { tools: { gmail: { actions: '*', confirm: 'ask' }, 'google-drive': { actions: '*', confirm: 'ask' } } };
    const fb = P.fallbackToolPolicy({ agentConfig: curated, tools: STACK });

    assert.ok(fb.gatedTools.has('gmail_compose'),
        'a send its owner has to approve may not become a plain dispatch because a build threw');
    assert.ok(fb.gatedTools.has('drive_upload_file'),
        'a write the owner put on "ask" is a decision someone made — losing it is losing the decision');
    assert.ok(!fb.gatedTools.has('gmail_search'), 'a read still has nothing to approve');
    assert.deepStrictEqual([...fb.allowedToolNames].sort(),
        ['drive_upload_file', 'gmail_compose', 'gmail_search', 'set_reminder'],
        'gate 1 is unchanged: exactly the stack that was offered, nothing more');
});

test('fallback: a headless run holds the gated tool rather than dispatching it', () => {
    const curated = { tools: { gmail: { actions: '*' } } };
    const fb = P.fallbackToolPolicy({ agentConfig: curated, tools: STACK, unattended: true });

    assert.ok(fb.gatedTools.has('gmail_compose'),
        'this is the case that mattered: the assembly catch left the tool in the stack, so the ' +
        'round gate is the only thing between a broken policy and an unapproved send');
    assert.strictEqual(fb.unattended, true);
    assert.deepStrictEqual(fb.droppedForUnattended, [],
        'nothing is reported as withheld — the stack was assembled before the failure');
});

test('fallback: an agent with no curated map is untouched — still invisible', () => {
    for (const [label, agentConfig] of [
        ['no map', { enabledIntegrations: ['gmail'] }],
        ['empty map', { tools: {} }],
        ['junk-only map', { tools: { gmail: 'nope' } }],
    ]) {
        const fb = P.fallbackToolPolicy({ agentConfig, tools: STACK });
        assert.strictEqual(fb.gatedTools.size, 0,
            `${label}: nobody curated anything, so there is no decision to fail closed on — ` +
            'gating here would take the draft card off every agent that predates the picker');
        assert.ok(fb.allowedToolNames.has('gmail_compose'));
        assert.strictEqual(P.buildToolPolicy({ agentConfig, tools: STACK }).gatedTools.size, 0,
            `${label}: and the healthy path agrees, which is what "untouched" means`);
    }
});

test('fallback: unreadable input is gated, never thrown on', () => {
    // The handler for something that already threw may not throw itself.
    for (const tools of [null, undefined, [null, {}, { function: {} }, { function: { name: '' } }]]) {
        const fb = P.fallbackToolPolicy({ agentConfig: { tools: { gmail: { actions: '*' } } }, tools });
        assert.strictEqual(fb.allowedToolNames.size, 0, 'an unnameable entry is not a name');
    }

    // A config that refuses to be read at all: "I could not check" is not a yes.
    const hostile = { get tools() { throw new Error('nope'); } };
    const fb = P.fallbackToolPolicy({ agentConfig: hostile, tools: STACK });
    assert.ok(fb.gatedTools.has('gmail_compose') && fb.gatedTools.has('drive_upload_file'),
        'grants nobody can read hold every write back rather than waving it through');
    assert.ok(fb.allowedToolNames.has('gmail_search'), 'and gate 1 still describes the stack');
});

test('fallback: decideToolCall reads it the same way it reads a healthy policy', () => {
    const fb = P.fallbackToolPolicy({
        agentConfig: { tools: { gmail: { actions: '*' } } }, tools: STACK,
    });
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_compose', policy: fb }).action, 'confirm');
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_search', policy: fb }).action, 'run');
    assert.strictEqual(P.decideToolCall({ toolName: 'automation_pay_invoice', policy: fb }).action, 'refuse',
        'the injected-name gate is the half that already worked, and it still does');
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_compose', policy: fb }).effect, 'sends',
        'the card still names the effect — effectByTool is filled, not left for decideToolCall to guess');
});

test('fallback: an explicit per-automation confirm survives the failure too', () => {
    const tools = [{ function: { name: 'summarise_inbox' } }, { function: { name: 'mail_the_client' } }];
    const confirms = new Map([['summarise_inbox', 'direct'], ['mail_the_client', 'ask']]);
    const fb = P.fallbackToolPolicy({ agentConfig: {}, tools, automationConfirms: confirms });

    assert.deepStrictEqual([...fb.gatedTools], ['mail_the_client'],
        'the automation\'s own definition is a decision — the fallback may not implement half the rule');
    assert.ok(!fb.gatedTools.has('summarise_inbox'), 'and an automation set to direct stays direct');
    assert.deepStrictEqual(
        [...P.buildToolPolicy({ agentConfig: {}, tools, automationConfirms: confirms }).gatedTools],
        [...fb.gatedTools], 'the two builders agree about what a chosen confirm means');
});


// ── A registry that hiccups may not hand out tools ──────────────────
// _buildAppIndex used to swallow the failure and return an EMPTY index, at
// which point every tool was "unattributed" and isToolAllowed said yes to all
// of them. An agent curated down to gmail_search was then handed gmail_compose
// and drive_upload_file because a require threw — grants going fail-OPEN on
// the one path that has no second gate behind it (integrationTools' addTools
// is what builds the stack in the first place).

/**
 * Run `fn` with the tool registry throwing, then put the index back.
 *
 * The console is captured rather than silenced: a fail-closed refusal nobody
 * can see in the log is how a "why did my agent lose its tools" ticket becomes
 * a week of guessing. `fn` receives the lines it produced.
 */
function withBrokenRegistry(fn) {
    const lines = [];
    const realError = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    REGISTRY_BROKEN = true;
    P._resetAppIndex();
    try { return fn(lines); } finally {
        console.error = realError;
        REGISTRY_BROKEN = false;
        P._resetAppIndex();
    }
}

/**
 * Draai `fn` met de MODULE van één app onleesbaar — de vorm die de echte bron
 * produceert. `loadTools` gooit namelijk nooit: hij vangt zijn eigen fout en
 * geeft `[]` terug, dus de "degraded" tak die op een throw wachtte was in
 * productie onbereikbaar. Zonder deze test is de hele verdediging groen op iets
 * dat nooit gebeurt.
 */
function withUnloadableApp(appId, fn) {
    const lines = [];
    const realError = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    LOAD_FAILS_FOR.add(appId);
    P._resetAppIndex();
    try { return fn(lines); } finally {
        console.error = realError;
        LOAD_FAILS_FOR.delete(appId);
        P._resetAppIndex();
    }
}

test('een app die NIET LAADT degradeert de attributie — leeg is geen antwoord', () => {
    const curated = { gmail: { actions: ['gmail_search'] } };
    assert.ok(P.isToolAllowed('gmail_search', curated), 'precondition: gezond');

    withUnloadableApp('gmail', (log) => {
        assert.strictEqual(P.isAttributionAvailable(), false,
            'een module die niet laadt maakt de attributie INCOMPLEET, en incompleet is geen feit');
        assert.strictEqual(P.appIdForTool('gmail_compose'), null,
            'precondition: de naam is nu ongeattribueerd — precies de lezing die alles doorliet');
        assert.ok(!P.isToolAllowed('gmail_compose', curated),
            'heel Gmail terugkrijgen omdat één require faalde is de fail-open die dit sluit');
        assert.ok(!P.isToolAllowed('gmail_search', curated), 'ook de gekozen actie niet');
        assert.strictEqual(P.confirmForTool('gmail_create_draft', curated), 'ask',
            '"ik kon de keuze niet vinden" is geen "er was er geen"');
        assert.strictEqual(P.mayLendOwnerConnection('gmail_search', { tools: curated }), false,
            'en de live verbinding van de eigenaar gaat zeker niet naar een ander');
        assert.ok(log.some(l => l.includes('degraded') || l.includes('failed to load')),
            'en het staat in het log — een stille weigering is een week zoeken');
    });

    assert.ok(P.isToolAllowed('gmail_search', curated), 'en na herstel is het weer gewoon');
});

test('een app die niet laadt sluit ook het browse_web-gat niet weer open', () => {
    const curated = { gmail: { actions: ['gmail_search'] } };
    withUnloadableApp('browser-fetch', () => {
        // De DECLARATIE wordt gelezen vóór de module (zie `_buildAppIndex`),
        // dus die blijft staan ook als de tools niet laden — de smalste van de
        // twee lezingen.
        assert.strictEqual(P.appRequiresExplicitGrant('browser-fetch'), true);
        assert.strictEqual(P.appIdForTool('browse_web'), null, 'de naam is nu ongeattribueerd');
        assert.ok(!P.isToolAllowed('browse_web', curated),
            'en dan weigert de degraded tak hem alsnog — het gat blijft dicht');
    });
});

test('een verzendende tool leent NOOIT de verbinding van de eigenaar', () => {
    // De regel stond al in normaliseToolsConfig en op de kaart, maar niet in de
    // poort zelf — en daar gold hij dus niet op de wijdste tak: de agent die
    // niemand cureerde. Die leende `gmail_compose` van de eigenaar uit aan
    // iedereen die de agent draaide.
    for (const cfg of [null, {}, { tools: {} }, { tools: { gmail: 'nope' } }]) {
        assert.strictEqual(P.mayLendOwnerConnection('gmail_compose', cfg), false,
            'geen curatie is geen vrijbrief om te versturen onder andermans naam');
        assert.strictEqual(P.mayLendOwnerConnection('gmail_search', cfg), true,
            'lezen leent onveranderd — dit is geen stille migratie');
    }
    // En op een gecureerde agent kan geen opgeslagen ja eromheen.
    assert.strictEqual(
        P.mayLendOwnerConnection('gmail_compose', { tools: { gmail: { actions: '*', actAs: 'owner' } } }),
        false, 'ook een opgeslagen "owner" praat zich er niet uit');
});

test('a broken registry gives a CURATED agent no tools instead of every tool', () => {
    const curated = { gmail: { actions: ['gmail_search'] } };

    // Precondition: healthy, this is a real grant that lets exactly one tool by.
    assert.ok(P.isToolAllowed('gmail_search', curated));
    assert.ok(!P.isToolAllowed('gmail_compose', curated));
    assert.strictEqual(P.isAttributionAvailable(), true);

    withBrokenRegistry((log) => {
        assert.strictEqual(P.isAttributionAvailable(), false,
            'the index has to ADMIT it could not answer — an empty one looks identical to "nothing ' +
            'claims these names", and that is the reading that granted everything');
        assert.ok(!P.isToolAllowed('gmail_compose', curated),
            'the tool its owner unticked may not arrive because the registry hiccupped');
        assert.ok(!P.isToolAllowed('drive_upload_file', curated),
            'nor a tool of an app that was never granted at all');
        assert.ok(!P.isToolAllowed('gmail_search', curated),
            'not even the granted one: "I cannot tell which app owns this" is not a grant, and a ' +
            'curated agent losing tools for a minute beats it silently gaining them');
        assert.ok(log.some(l => /registry/i.test(l)) && log.some(l => /degraded/i.test(l)),
            'and it says so out loud — silently serving an empty toolbelt is its own kind of lie');
    });

    // ...and it recovers on its own: a transient failure must not deny this
    // agent its toolbelt until someone restarts the process.
    assert.ok(P.isToolAllowed('gmail_search', curated));
    assert.strictEqual(P.isAttributionAvailable(), true);
});

test('a broken registry changes NOTHING for an agent without grants', () => {
    withBrokenRegistry(() => {
        for (const name of ['gmail_compose', 'drive_upload_file', 'set_reminder']) {
            assert.ok(P.isToolAllowed(name, null),
                'no map means no per-action rule to fail closed on — this is every agent in the product');
            assert.ok(P.isToolAllowed(name, {}),
                'and a map-shaped nothing is the same nothing here as everywhere else');
            assert.ok(P.isToolAllowed(name, { gmail: 'nope' }),
                'as is a junk-only map — an entry every reader drops is not a picked list to protect');
        }
        assert.strictEqual(P.confirmForTool('drive_upload_file', null), 'direct',
            'and a write it has always just done must not start asking because a registry blipped');
    });
});

test('a broken registry does not let "as the owner" survive on an unreadable app', () => {
    // `actions:'*'` plus a lent connection: whether this app has a send action
    // is a registry question, and an unanswered one may not come back "no".
    withBrokenRegistry(() => {
        const out = P.normaliseToolsConfig(
            { tools: { gmail: { actions: '*', actAs: 'owner' } } },
            { lentProviders: new Set(['gmail', 'google']) },
        );
        assert.strictEqual(out.tools.gmail.actAs, 'viewer');
    });
});

test('a broken registry leaves MCP and custom grants working — they carry their own id', () => {
    const mcpTool = { function: { name: 'tuya_list_devices' }, _mcp: { serverId: 'tuya' } };
    const customTool = { function: { name: 'anything' }, _custom: { integrationId: 'abc' } };

    withBrokenRegistry(() => {
        assert.ok(P.isToolAllowed(mcpTool, { 'mcp:tuya': { actions: ['tuya_list_devices'] } }));
        assert.ok(!P.isToolAllowed(mcpTool, { 'mcp:tuya': { actions: ['tuya_something_else'] } }),
            'the grant still narrows: attribution came off the definition, not the registry');
        assert.ok(P.isToolAllowed(customTool, { 'custom:abc': { actions: '*' } }));
    });
});

test('a broken registry holds a curated write back rather than dispatching it silently', () => {
    // The owner put Drive on "ask". With attribution degraded the entry cannot
    // be found — and a decision that cannot be found is not the absence of one.
    const curated = { 'google-drive': { confirm: 'ask' } };
    withBrokenRegistry(() => {
        assert.strictEqual(P.confirmForTool('drive_upload_file', curated), 'ask');
    });
});

// ── Only a section that GATES counts as a curation ──────────────────
// hasCuratedGrants is the whole opt-in. Counting a section that enforces
// nothing flips the agent into the confirmation regime by accident: one
// datatable grant put EVERY send tool on ask — a held card in an attended run,
// and the tool gone from the stack entirely in an unattended one — while no
// approve/resume endpoint exists to answer the card with.

test('a datatables grant IS a curation — since A1c something enforces it', () => {
    // It was NOT, for two releases, and the reason is worth keeping: nothing
    // read the section, so counting it flipped every send tool of the agent to
    // `ask` (unattended: out of the stack entirely) on the strength of a
    // section that changed nothing about what ran. `datatable_query` reads it
    // now, so picking a table is a trip through the picker like any other.
    const curated = { datatables: { t1: { scope: 'own', columns: '*' } } };
    assert.strictEqual(P.hasCuratedGrants(curated), true);
    assert.strictEqual(P.hasCuratedGrants({ datatables: {} }), false,
        'an empty section is nobody\'s choice — the same rule automations follows');

    const tools = [{ function: { name: 'gmail_compose' } }, { function: { name: 'gmail_search' } }];
    const attended = P.buildToolPolicy({ agentConfig: { tools: curated }, tools });
    assert.ok(attended.gatedTools.has('gmail_compose'), 'a curated agent holds its sends back');
    assert.ok(!attended.gatedTools.has('gmail_search'), 'and never holds a read back');
});

test('the test for a reserved section is "does anything enforce it", not "is it reserved"', () => {
    // The rule GATING_RESERVED_KEYS encodes. A section added to
    // RESERVED_TOOL_KEYS without an enforcement site has to stay off this list,
    // or it opts agents into the confirmation regime by accident.
    for (const key of P.GATING_RESERVED_KEYS) {
        assert.ok(P.RESERVED_TOOL_KEYS.includes(key), `${key} gates, so it must also be reserved`);
        assert.strictEqual(P.hasCuratedGrants({ [key]: { x: {} } }), true, key);
    }
});

test('an automations grant IS a curation — that one narrows what is offered', () => {
    assert.strictEqual(P.hasCuratedGrants({ automations: { a1: {} } }), true);
    assert.strictEqual(P.hasCuratedGrants({ automations: {} }), false, 'an empty section is nobody\'s choice');
});

// ── automations[].confirm is enforced, not decoration ────────────────
// The grant is keyed on the automation ID and the tool is named per user at
// assembly time, so the two can only be married against the ASSEMBLED stack.
// Nothing did that, which is how `confirm` came to be stored and ignored.

const automation = (name, id) => ({ function: { name }, __automation: { id } });

test('automationConfirmsFor maps a granted automation\'s confirm onto its tool name', () => {
    const stack = [automation('mail_the_client', 'auto-1'), automation('summarise_inbox', 'auto-2'), { function: { name: 'gmail_search' } }];
    const cfg = { tools: { automations: { 'auto-1': { confirm: 'ask' }, 'auto-2': { confirm: 'direct' } } } };

    const confirms = P.automationConfirmsFor(stack, cfg);
    assert.strictEqual(confirms.get('mail_the_client'), 'ask');
    assert.strictEqual(confirms.get('summarise_inbox'), 'direct');
    assert.strictEqual(confirms.has('gmail_search'), false, 'a tool that is not an automation has no grant to read');

    // And the policy acts on it: the stored "ask" holds the call back.
    const policy = P.buildToolPolicy({ agentConfig: cfg, tools: stack, automationConfirms: confirms });
    assert.ok(policy.gatedTools.has('mail_the_client'),
        'a stored per-automation confirm that holds nothing back is a lie the owner cannot see through');
    assert.ok(!policy.gatedTools.has('summarise_inbox'));

    // Nobody watching ⇒ the automation its owner wanted approved is withheld.
    const headless = P.buildToolPolicy({ agentConfig: cfg, tools: stack, unattended: true, automationConfirms: confirms });
    assert.deepStrictEqual(headless.droppedForUnattended, ['mail_the_client']);
});

test('a typo in an automation confirm holds the automation back — it does not run it', () => {
    // End to end over the clamp: this is the value a hand-written config (or a
    // picker sending a label instead of a mode) actually produces, and before
    // the clamp read it the automation dispatched with no card at all.
    const stack = [automation('mail_the_client', 'auto-1')];
    const norm = P.normaliseToolsConfig({ tools: { automations: { 'auto-1': { confirm: 'Ask' } } } });
    const cfg = { tools: norm.tools };

    const confirms = P.automationConfirmsFor(stack, cfg);
    assert.strictEqual(confirms.get('mail_the_client'), 'ask');

    const policy = P.buildToolPolicy({ agentConfig: cfg, tools: stack, automationConfirms: confirms });
    assert.ok(policy.gatedTools.has('mail_the_client'),
        'the unreadable half falls to the safe side, or a typo mails the client unasked');
    assert.strictEqual(P.decideToolCall({ toolName: 'mail_the_client', policy }).action, 'confirm');
});

test('automationConfirmsFor is empty — and free — for an agent that grants no automations', () => {
    const stack = [automation('mail_the_client', 'auto-1')];
    for (const cfg of [null, {}, { tools: {} }, { tools: { gmail: { actions: '*' } } }, { tools: { automations: {} } }]) {
        assert.strictEqual(P.automationConfirmsFor(stack, cfg).size, 0);
    }
    // A grant without a confirm is a grant, not an override: the automation is
    // offered, and nothing about how it dispatches changes.
    const granted = P.automationConfirmsFor(stack, { tools: { automations: { 'auto-1': {} } } });
    assert.strictEqual(granted.size, 0);
});

// ── actAs is read at BOTH dispatch sites ─────────────────────────────
// toolRoundExecutor (streaming) and chatWithAgent (non-streaming) both borrow
// the owner's connection, and only the first one asked. An owner cannot tell
// which route a caller lands on, so a restriction that holds on one of two
// dispatches is the same silently-ignored setting the grants layer exists to
// abolish. Both now call `mayLendOwnerConnection`.

test('actAsForTool answers per app, and "viewer" is the answer it has to give by default', () => {
    const cfg = { gmail: { actions: '*', actAs: 'viewer' }, 'google-drive': { actions: '*', actAs: 'owner' } };
    assert.strictEqual(P.actAsForTool('gmail_compose', cfg), 'viewer');
    assert.strictEqual(P.actAsForTool('drive_search', cfg), 'owner');
    assert.strictEqual(P.actAsForTool('kb_search', cfg), 'viewer', 'an app with no entry never borrows');
    assert.strictEqual(P.actAsForTool('set_reminder', cfg), 'viewer');
});

test('the lending gate hangs on hasCuratedGrants, not on the bare key', () => {
    // Every one of these is "exactly like no map" everywhere else in this
    // module — and `{}` is not hypothetical: the clamp and the route both
    // WRITE it the moment a refused section was all a map held. Hanging the
    // gate on `config.tools` being truthy switched lending off for all of
    // them, which is a behaviour change on agents nobody curated. (A
    // datatables map used to be in this list. It is a real curation since A1c,
    // so it belongs with the curated cases below instead.)
    for (const cfg of [{}, { tools: {} }, { tools: { gmail: 'nope' } }, { tools: { automations: {} } }]) {
        assert.strictEqual(P.hasCuratedGrants(P.toolsConfigOf(cfg)), false);
        assert.strictEqual(P.mayLendOwnerConnection('drive_search', cfg), true,
            'an uncurated agent lends exactly as it did before this layer existed');
    }
});

test('the lending gate obeys a recorded actAs, and only a recorded one', () => {
    const curated = {
        tools: {
            gmail: { actions: ['gmail_search'], actAs: 'viewer' },
            'google-drive': { actions: ['drive_search'], actAs: 'owner' },
        },
    };
    assert.strictEqual(P.mayLendOwnerConnection('drive_search', curated), true,
        '"as the owner" is the whole point of the lend grant');
    assert.strictEqual(P.mayLendOwnerConnection('gmail_search', curated), false,
        'and "as the person asking" is a refusal both dispatch sites have to honour');

    // Een app ZONDER entry in een gecureerde map leende hier tot A2-2 wél —
    // "geen beslissing opgeschreven", net als bij `actions`, waar dat alles
    // gunt. Bij een IDENTITEIT-vraag mag dat niet: de kaart tekende voor
    // diezelfde toestand "as the person asking" en de runtime gaf ondertussen
    // de verbinding van de eigenaar weg. Nu is alleen een OPGESLAGEN ja een ja
    // — zie de test hieronder voor de hele redenering.
    assert.strictEqual(P.mayLendOwnerConnection('kb_search', curated), false,
        'nothing is recorded for the Knowledge Base, and nothing recorded is not a yes');
    assert.strictEqual(P.mayLendOwnerConnection('set_reminder', curated), true,
        'but a name NO app claims is untouched: a grant keyed on an app cannot speak about it');

    // An entry whose actAs is missing or junk is no decision either — normalise
    // writes a real one on every entry it emits, so this is only ever a map
    // that never went through it, and unreadable narrows here like everywhere.
    assert.strictEqual(P.mayLendOwnerConnection('gmail_search', { tools: { gmail: { actions: ['gmail_search'] } } }), false);
    assert.strictEqual(P.mayLendOwnerConnection('gmail_search', { tools: { gmail: { actAs: 'OWNER' } } }), false);
});

// ── A2-2: het scherm en de runtime moeten over DEZELFDE toestand hetzelfde
// zeggen ─────────────────────────────────────────────────────────────
// De Tools-kaart tekent "As: the person asking" zodra er geen `actAs` is
// opgeslagen (canUse/toolGrants.js: `storedActAsOf` → null ⇒ ACT_AS.VIEWER),
// terwijl deze poort voor een app ZONDER entry `true` gaf en de runtime dus de
// verbinding van de EIGENAAR uitleende. Die twee mogen niet naast elkaar
// bestaan, en het scherm is de kant die klopt: een leenpoort die opengaat
// omdat er niets is opgeschreven, is precies het fail-open dat deze laag
// uitsluit.
//
// De config hieronder is LETTERLIJK dezelfde als in
// agent-hub/src/components/agents/AgentWizard/canUse/ToolsCard.test.jsx
// (A2_2_CURATED) — één toestand, twee kanten, één antwoord.
const A2_2_CURATED = Object.freeze({
    tools: {
        // De eigenaar heeft alleen Gmail gecureerd. Over Drive en de
        // Knowledge Base heeft hij nooit iets gezegd.
        gmail: { actions: ['gmail_search'], actAs: 'viewer' },
    },
});

test('an app with NO entry does not borrow the owner connection: only a stored yes lends', () => {
    assert.strictEqual(P.hasCuratedGrants(P.toolsConfigOf(A2_2_CURATED)), true,
        'this agent has been through the picker — the gate is armed');

    assert.strictEqual(P.mayLendOwnerConnection('drive_search', A2_2_CURATED), false,
        'the card shows "as the person asking" for an app with no entry, so the runtime may not ' +
        'quietly hand out the owner\'s connection there');
    assert.strictEqual(P.mayLendOwnerConnection('kb_search', A2_2_CURATED), false,
        'and that holds for every app the owner never opened, not just the lendable ones');

    // Een OPGESLAGEN ja blijft een ja — dat is waar de leen-grant voor is.
    assert.strictEqual(
        P.mayLendOwnerConnection('drive_search', {
            tools: { ...A2_2_CURATED.tools, 'google-drive': { actions: '*', actAs: 'owner' } },
        }),
        true, 'a recorded "as you" is the whole point of the lend grant');

    // Een `actAs` die niemand kan lezen is geen ja. Normalisatie schrijft er
    // een geldige op elke entry die zij uitgeeft, dus dit is alleen een map
    // die daar nooit langs is geweest — en onleesbaar versmalt hier, net als
    // bij `actions` en bij `columns`.
    assert.strictEqual(P.mayLendOwnerConnection('gmail_search', { tools: { gmail: { actions: ['gmail_search'] } } }), false);
    assert.strictEqual(P.mayLendOwnerConnection('gmail_search', { tools: { gmail: { actAs: 'OWNER' } } }), false);

    // En de opt-in-grens blijft ongemoeid: een agent die niemand gecureerd
    // heeft leent precies zoals vóór deze laag. Dat is de enige plek waar
    // "geen opgeslagen ja" nog leent, en de kaart zegt dat daar ook.
    for (const cfg of [{}, { tools: {} }, { tools: { gmail: 'nope' } }, { tools: { automations: {} } }]) {
        assert.strictEqual(P.mayLendOwnerConnection('drive_search', cfg), true);
    }
});

test('the lending gate is total: an unreadable config is a refusal, not a throw', () => {
    const hostile = { get tools() { throw new Error('nope'); } };
    assert.strictEqual(P.mayLendOwnerConnection('gmail_search', hostile), false,
        'it runs inside dispatch — it may not throw, and "I could not read it" is not a yes');
    assert.strictEqual(P.mayLendOwnerConnection(null, null), true);
});

test('a broken registry does not lend a curated agent the owner connection', () => {
    // Same rule as isToolAllowed and confirmForTool: with attribution degraded
    // every name looks unattributed, so the owner's per-app answer cannot be
    // found — and a missing answer is not a yes. The fallback is
    // bring-your-own, which is the pre-lending behaviour.
    const curated = { tools: { 'google-drive': { actions: ['drive_search'], actAs: 'owner' } } };
    assert.strictEqual(P.mayLendOwnerConnection('drive_search', curated), true);

    withBrokenRegistry((log) => {
        assert.strictEqual(P.mayLendOwnerConnection('drive_search', curated), false);
        assert.ok(log.some(l => /degraded/i.test(l)), 'and it says so');
        assert.strictEqual(P.mayLendOwnerConnection('drive_search', { enabledIntegrations: ['google-drive'] }), true,
            'while an agent without grants keeps lending — there is no answer of its owner to lose');
    });
});

// ── Gate 1 is opt-in like the rest ──────────────────────────────────
// It shipped global: EVERY agent refused a name outside the offered stack,
// where before the grants layer it went on to the dispatcher (which resolves
// the caller's own automations and Steps, answers a progressive-disclosure name
// with a "load that group first" hint, and otherwise tries a component tool).
// That is a behaviour change with no field behind it, on an agent nobody
// curated — exactly what this layer promised not to do.

test('an unoffered name: refused for a curated agent, passed on for an uncurated one', () => {
    const stack = ['gmail_search'];
    const curated = policyFor({ tools: { gmail: { actions: ['gmail_search'] } } }, stack);
    const legacy = policyFor({ enabledIntegrations: ['gmail'] }, stack);

    assert.strictEqual(curated.enforceNames, true);
    assert.strictEqual(P.decideToolCall({ toolName: 'automation_pay_invoice', policy: curated }).action, 'refuse',
        'curating the agent is what closes its stack — an injected automation name stops here');

    assert.strictEqual(legacy.enforceNames, false);
    const d = P.decideToolCall({ toolName: 'automation_pay_invoice', policy: legacy });
    assert.strictEqual(d.action, 'run',
        'and an agent nobody curated keeps the pre-grants path: the dispatcher decides, as it always did');
    assert.strictEqual(d.reason, 'not_offered_unenforced',
        'named apart from a plain allow so the round executor can log it — visible, without a ' +
        'behaviour change nobody opted into');

    // The tools it WAS offered are unaffected either way.
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_search', policy: legacy }).action, 'run');
    assert.strictEqual(P.decideToolCall({ toolName: 'gmail_search', policy: curated }).action, 'run');
    // An unnameable call is still refused whatever the fence says.
    assert.strictEqual(P.decideToolCall({ toolName: '', policy: legacy }).action, 'refuse');
});

test('an automation carrying its own confirm arms the gate too', () => {
    // The withheld-in-a-headless-run case: the tool is out of the stack
    // BECAUSE someone chose 'ask', so letting the name through to the
    // dispatcher would run the very thing that was withheld.
    const policy = P.buildToolPolicy({
        agentConfig: {}, unattended: true,
        tools: [{ function: { name: 'mail_the_client' } }],
        automationConfirms: new Map([['mail_the_client', 'ask']]),
    });
    assert.strictEqual(policy.enforceNames, true);
    assert.strictEqual(P.decideToolCall({ toolName: 'mail_the_client', policy }).action, 'refuse');
});

test('the fallback policy keeps the same fence', () => {
    const curated = P.fallbackToolPolicy({ agentConfig: { tools: { gmail: { actions: '*' } } }, tools: STACK });
    assert.strictEqual(curated.enforceNames, true);
    assert.strictEqual(P.decideToolCall({ toolName: 'automation_pay_invoice', policy: curated }).action, 'refuse');

    const legacy = P.fallbackToolPolicy({ agentConfig: { enabledIntegrations: ['gmail'] }, tools: STACK });
    assert.strictEqual(legacy.enforceNames, false);
    assert.strictEqual(P.decideToolCall({ toolName: 'automation_pay_invoice', policy: legacy }).reason,
        'not_offered_unenforced');

    // A config nobody can read counts as curated, so a failure never OPENS the
    // gate for an agent that has a map.
    const hostile = { get tools() { throw new Error('nope'); } };
    assert.strictEqual(P.fallbackToolPolicy({ agentConfig: hostile, tools: STACK }).enforceNames, true);
});


// ── Unreadable is not a grant, on BOTH readers ───────────────────────
//
// From the manual review of this layer before A2 (finding 2 in
// .claude/handoff/A1B-RECHTENLAAG-REVIEW.md). `normaliseToolsConfig` already
// said it out loud — "a value nobody can read is not a request for
// everything", so junk `actions` becomes `[]` — while `allowedToolsFor`
// answered `null`, which every reader here takes as the whole app. Two readers
// of one field, disagreeing about the same word, and only one of them runs at
// dispatch. Today the clamp on the read path hides it; the invariant that
// keeps it hidden is not enforced anywhere.
test('junk in `actions` grants nothing — the same reading normalisation gives it', () => {
    for (const junk of [42, {}, 'gmail_search', true, 0, '']) {
        const cfg = { gmail: { actions: junk } };
        assert.strictEqual(
            P.isToolAllowed('gmail_compose', cfg), false,
            `actions: ${JSON.stringify(junk)} must not grant the whole app`,
        );
    }
    // The two documented "all of it" spellings still mean all of it.
    for (const all of ['*', undefined, null]) {
        assert.strictEqual(P.isToolAllowed('gmail_compose', { gmail: { actions: all } }), true);
    }
});

test('the two readers agree: what normalisation writes is what the reader enforces', () => {
    const { tools } = P.normaliseToolsConfig({ tools: { gmail: { actions: 'gmail_search' } } });
    assert.deepStrictEqual(tools.gmail.actions, [], 'normalisation narrows it');
    assert.strictEqual(P.isToolAllowed('gmail_compose', tools), false);
    // And the RAW map — the one that reaches this reader when nothing clamped
    // it — now reaches the same verdict instead of the opposite one.
    assert.strictEqual(P.isToolAllowed('gmail_compose', { gmail: { actions: 'gmail_search' } }), false);
});

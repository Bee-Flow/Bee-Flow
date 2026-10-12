/**
 * core/webpages/webpageBindings — de USAGE-INDEX: WELKE tabel, WELKE automatisering,
 * WELKE agent hangt er via een `bf-*`-element aan deze pagina?
 *
 * De buurtest van webpageBindings.bfMarks.test.js. Die gaat over WAAR een
 * element staat (de markeringen in de Code-tab); deze gaat over WAARAAN het
 * hangt — wat de middenkolom toont en wat "Wordt gebruikt door" omdraait.
 *
 * Wat hier vastligt is niet dat de parser slim is, maar wat de index mag
 * BEWEREN. Eén regel draagt alles:
 *
 *   een aanwijsbare binding komt in `targets`, en al het andere komt in
 *   `unresolved` — nooit als stilte, en nooit als een verzonnen id.
 *
 * Dat laatste is het gevaarlijkst van de twee. `{id}` uit een JSX-uitdrukking
 * ziet er in een usage-index precies zo echt uit als `tbl_1`; wie erop afgaat,
 * verwijdert de verkeerde tabel of denkt dat er een automatisering aan hangt die niet
 * bestaat. "Niet te lezen" is een antwoord, een verzonnen id niet.
 *
 * Apart van webpageBindings.test.js omdat `node --test --test-force-exit` bij
 * een lang bestand niet-deterministisch afkapt (de samenvatting kwam terug met
 * 29, 31, 34 of 36 van dezelfde 36 tests, telkens met fail 0). Een test die
 * stilletjes niet draait is erger dan een test die faalt.
 *
 * Draaien: cd server && node --test --test-force-exit core/webpages/webpageBindings.uses.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const storageStore = require('../../stores/storageStore');
const webpageStore = require('../../stores/webpageStore');
const bfElements = require('./bfElements');
const bindings = require('./webpageBindings');

const OWNER = 'u-owner';

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return Promise.resolve().then(fn).finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

function stubs({
    available = true, slots = { html: '', css: '', js: '' },
    extras = [], grants = null,
} = {}) {
    return [
        [storageStore, 'isAvailable', () => available],
        [webpageStore, 'readAllSlots', async () => slots],
        [webpageStore, 'listExtraFiles', async () => extras.map(e => ({ path: e.path, isText: true, mimeType: 'text/jsx' }))],
        [webpageStore, 'readExtraFile', async ({ path }) => ({ text: extras.find(e => e.path === path)?.text ?? '' })],
        [bridgeGrants, 'getBridgeGrants', async () => grants || { ai: {}, automations: [], integrations: [], tables: [], agent: null }],
    ];
}

// ── de elementen: welke tabel, welke automatisering, welke agent ─────────────
//
// De markeringen (`scanBfElements`) zeggen WAAR een element staat; de index
// (`collectUses`) zegt WAARAAN het hangt. Wat hier vastligt is niet dat de
// parser slim is, maar wat de index mag BEWEREN: een aanwijsbare binding komt
// erin, en alles wat niet aan te wijzen viel komt terug als `unresolved` — nooit
// als stilte en nooit als een verzonnen id.

const PAGE_AGENT = { 'bridge_grants.agent': 'ag_page' };

/** De hele pagina in één string; de regelnummers hieronder tellen vanaf 1. */
const FIVE = [
    '<html><body>',
    '<bf-table source="tbl_1"></bf-table>',
    '<bf-stat source="tbl_1" agg="sum" column="price"></bf-stat>',
    '<bf-button run="auto_1">Go</bf-button>',
    '<bf-form automation="auto_2"><input name="email"></bf-form>',
    '<bf-agent agent="ag_1"></bf-agent>',
    '</body></html>',
].join('\n');

function usesOf(files, fallbackIds = PAGE_AGENT) {
    return bindings.collectUses(bindings.scanBfElements(files), { fallbackIds });
}

test('all five elements are recognised, each with the thing it binds', () => {
    const scan = bindings.scanBfElements({ html: FIVE });
    assert.strictEqual(scan.counts.total, 5);
    assert.strictEqual(scan.counts.known, 5, 'geen enkel element van het vocabulaire mag onopgemerkt blijven');
    assert.deepStrictEqual(scan.unknownTags, []);
    // Elk element uit de registry komt precies één keer voor, op zijn eigen regel.
    assert.deepStrictEqual(scan.marks.map(m => m.tag).sort(), [...bfElements.BF_TAGS].sort());
    assert.deepStrictEqual(scan.marks.map(m => m.line), [2, 3, 4, 5, 6]);

    const { targets, unresolved } = bindings.collectUses(scan, { fallbackIds: PAGE_AGENT });
    assert.deepStrictEqual(unresolved, []);
    assert.deepStrictEqual(targets.datatable.map(t => t.id), ['tbl_1']);
    assert.strictEqual(targets.datatable[0].count, 2, 'bf-table en bf-stat hangen aan dezelfde tabel');
    assert.deepStrictEqual(targets.datatable[0].elements.map(e => e.tag), ['bf-table', 'bf-stat']);
    assert.deepStrictEqual(targets.automation.map(t => t.id), ['auto_1', 'auto_2']);
    assert.deepStrictEqual(targets.agent.map(t => t.id), ['ag_1']);
    assert.strictEqual(targets.agent[0].fromPage, false, 'dit element noemt zijn agent zelf');
});

test('every binding family the vocabulary declares gets a key, even when nothing uses it', () => {
    // Anders is "deze pagina gebruikt geen automations" niet te onderscheiden van
    // "deze index kent het woord automatisering niet".
    const kinds = new Set();
    for (const def of bfElements.BF_ELEMENTS) if (def.binding) kinds.add(def.binding.kind);
    assert.ok(kinds.size >= 3, 'sanity: het vocabulaire kent meerdere families');
    const { targets } = usesOf({ html: '<html><body><p>niets</p></body></html>' });
    assert.deepStrictEqual([...Object.keys(targets)].sort(), [...kinds].sort());
    for (const kind of kinds) assert.deepStrictEqual(targets[kind], []);
});

test('BITE — a bf-agent without an id falls back to the PAGE agent and says so', () => {
    // Zonder terugval zou dit element geen agent hebben, en dan zou de kolom
    // "geen agent op deze pagina" tonen terwijl er een chatblok staat.
    const { targets, unresolved } = usesOf({ html: '<bf-agent></bf-agent>' });
    assert.deepStrictEqual(unresolved, []);
    assert.deepStrictEqual(targets.agent.map(t => t.id), ['ag_page']);
    assert.strictEqual(targets.agent[0].fromPage, true,
        'de kolom moet kunnen zeggen dat deze agent aan de PAGINA hangt en niet aan het element');
});

test('BITE — a page with no agent bound leaves the element unresolved, not absent', () => {
    // `null` als antwoord op de terugval betekent "de pagina heeft er geen".
    const { targets, unresolved } = usesOf({ html: '<bf-agent></bf-agent>' }, { 'bridge_grants.agent': null });
    assert.deepStrictEqual(targets.agent, []);
    assert.strictEqual(unresolved.length, 1);
    assert.strictEqual(unresolved[0].reason, 'page-binding-unknown');
    assert.strictEqual(unresolved[0].kind, 'agent');
});

test('BITE — "geen agent" en "de grants waren niet te lezen" krijgen NIET dezelfde reden', () => {
    // Allebei leverden ze `null` op, dus kwamen ze allebei op
    // 'page-binding-unknown' uit — terwijl het commentaar in de bron het
    // tegenovergestelde belooft. Het eerste is een keuze van de auteur, het
    // tweede een storing; wie ze niet uit elkaar kan houden, gaat een fout
    // zoeken die er niet is (of andersom, er een missen die er wel is).
    const none = usesOf({ html: '<bf-agent></bf-agent>' }, { 'bridge_grants.agent': null });
    const broken = usesOf({ html: '<bf-agent></bf-agent>' }, { 'bridge_grants.agent': bindings.FALLBACK_UNREADABLE });
    assert.strictEqual(none.unresolved[0].reason, 'page-binding-unknown');
    assert.strictEqual(broken.unresolved[0].reason, 'page-binding-unreadable');
    assert.notStrictEqual(none.unresolved[0].reason, broken.unresolved[0].reason);
    assert.deepStrictEqual(broken.targets.agent, [], 'en er wordt nog steeds niets verzonnen');
});

test('BITE — a fallback this module has no answer for is reported, never silently dropped', () => {
    // Wordt er ooit een terugval aan de registry toegevoegd zonder hem hier te
    // beantwoorden, dan mag dat element niet uit de index vallen.
    const { targets, unresolved } = usesOf({ html: '<bf-agent></bf-agent>' }, {});
    assert.deepStrictEqual(targets.agent, []);
    assert.strictEqual(unresolved.length, 1);
    assert.strictEqual(unresolved[0].reason, 'unknown-fallback');
});

test('BITE — an address the page builds while it runs is unresolved, never an invented id', () => {
    // `{id}` als datatable-id ziet er in een usage-index precies zo echt uit als
    // `tbl_1` en hoort daarna nergens meer bij.
    const scan = bindings.scanBfElements({
        extras: [{ path: 'src/App.jsx', text: '<bf-table source={tableId} />\n<bf-button run={`auto_${n}`} />' }],
    });
    assert.strictEqual(scan.counts.known, 2, 'de elementen zelf worden wél gezien');
    assert.strictEqual(scan.marks[0].dynamic, true);
    assert.strictEqual(scan.marks[0].targetId, null);
    // De auteur SCHREEF het attribuut, dus er ontbreekt niets — het is alleen
    // niet te lezen. Dat verschil moet blijven bestaan.
    assert.deepStrictEqual(scan.marks[0].missing, []);

    const { targets, unresolved } = bindings.collectUses(scan, { fallbackIds: PAGE_AGENT });
    assert.deepStrictEqual(targets.datatable, []);
    assert.deepStrictEqual(targets.automation, []);
    assert.strictEqual(unresolved.length, 2);
    assert.deepStrictEqual(unresolved.map(u => u.reason), ['built-at-runtime', 'built-at-runtime']);
    assert.strictEqual(/tableId|auto_|\{/.test(JSON.stringify(Object.values(targets).flat())), false,
        'geen enkele uitdrukking mag als id in de index belanden');
});

test('BITE — a required attribute that is simply missing is "no-target", not silence', () => {
    const { targets, unresolved } = usesOf({ html: '<bf-table></bf-table><bf-button>Go</bf-button>' });
    assert.deepStrictEqual(targets.datatable, []);
    assert.strictEqual(unresolved.length, 2);
    assert.deepStrictEqual(unresolved.map(u => u.reason), ['no-target', 'no-target']);
    assert.deepStrictEqual(unresolved[0].missing, ['source']);
    assert.deepStrictEqual(unresolved[1].missing, ['run']);
});

test('the older spelling of an attribute binds the same table', () => {
    // `datatable` is de oudere schrijfwijze van `source`; hij komt uit de
    // registry, dus deze scan hoeft er zelf niets van te weten.
    const { targets } = usesOf({ html: '<bf-table datatable="tbl_9"></bf-table>' });
    assert.deepStrictEqual(targets.datatable.map(t => t.id), ['tbl_9']);
});

test('BITE — an element the vocabulary does not know binds nothing and is named as unknown', () => {
    const scan = bindings.scanBfElements({ html: '<bf-widget action="a1">Klik</bf-widget>' });
    assert.deepStrictEqual(scan.unknownTags, ['bf-widget']);
    assert.strictEqual(scan.counts.known, 0);
    assert.strictEqual(scan.marks[0].known, false);
    assert.strictEqual(scan.marks[0].family, null);
    // `null`, niet `[]`: "er ontbreekt niets" is een uitspraak die je over iets
    // onbekends niet kunt doen.
    assert.strictEqual(scan.marks[0].missing, null);
    const { targets, unresolved } = bindings.collectUses(scan, { fallbackIds: PAGE_AGENT });
    assert.deepStrictEqual(unresolved, [], 'een onbekend element staat al in unknownTags');
    for (const list of Object.values(targets)) assert.deepStrictEqual(list, []);
});

test('BITE — the element scan reads ALL slots and extras, not just index.html', async () => {
    // Dezelfde blinde vlek als bij de oproepscan: een react-mui-pagina heeft
    // haar elementen in `src/`, en het js-slot kan markup samenstellen.
    const extras = [{ path: 'src/App.jsx', text: 'export default () => <bf-stat source="tbl_2" />;' }];
    const slots = { html: '', css: '', js: 'root.innerHTML = \'<bf-button run="auto_9">Go</bf-button>\';' };
    await withPatches(stubs({ slots, extras, grants: { agent: { agentId: 'ag_page' }, tables: [] } }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.uses.scanned, true);
        assert.deepStrictEqual(out.uses.targets.datatable.map(t => t.id), ['tbl_2']);
        assert.strictEqual(out.uses.targets.datatable[0].elements[0].source, 'src/App.jsx',
            'de auteur moet weten WELK bestand hij moet openen');
        assert.deepStrictEqual(out.uses.targets.automation.map(t => t.id), ['auto_9']);
        assert.strictEqual(out.uses.targets.automation[0].elements[0].source, 'script.js');
    });
});

test('BITE — code that cannot be read leaves the index unscanned, never empty', async () => {
    // Een lege index leest als "niets gebruikt deze pagina", en daar wordt een
    // tabel op verwijderd.
    await withPatches(stubs({ available: false }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.uses.scanned, false);
        assert.strictEqual(out.elements.scanned, false);
        assert.strictEqual(out.forms.scanned, false);
        assert.strictEqual(out.agent.scanned, false);
        for (const list of Object.values(out.uses.targets)) assert.deepStrictEqual(list, []);
    });
});

test('forms and the agent block are no longer reported as unsupported', async () => {
    // Ze bestonden als plaatshouder zolang `<bf-form>` en `<bf-agent>` niet
    // bestonden. Nu ze er zijn, is "dit kennen we niet" onwaar geworden.
    const slots = { html: '<bf-form automation="auto_1"></bf-form><bf-agent></bf-agent>', css: '', js: '' };
    await withPatches(stubs({ slots, grants: { agent: { agentId: 'ag_page' }, tables: [] } }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.forms.supported, true);
        assert.strictEqual(out.agent.supported, true);
        // …maar een publieke share draait het Agent-blok nog steeds niet.
        assert.strictEqual(out.agent.internalOnly, true);
        assert.strictEqual(out.agent.agentId, 'ag_page');
        assert.deepStrictEqual(out.uses.targets.automation.map(t => t.id), ['auto_1']);
        assert.deepStrictEqual(out.uses.targets.agent.map(t => t.id), ['ag_page']);
        assert.strictEqual(out.uses.targets.agent[0].fromPage, true);
    });
});

test('the same target used twice is one entry with both places', async () => {
    const { targets } = usesOf({
        html: '<bf-button run="auto_1">A</bf-button>\n<bf-button run="auto_1">B</bf-button>',
    });
    assert.strictEqual(targets.automation.length, 1);
    assert.strictEqual(targets.automation[0].count, 2);
    assert.deepStrictEqual(targets.automation[0].elements.map(e => e.line), [1, 2]);
});

// ── de terugval wordt UIT DE GRANTS gelezen, niet geraden ─────────────

test('BITE — the page fallback is read along the path the registry declares', async () => {
    // Het pad (`bridge_grants.agent`) staat in de registry en wordt letterlijk
    // gevolgd. Zonder dat zou een TWEEDE terugval het antwoord van de eerste
    // krijgen — een verkeerd id, en dat is het enige antwoord dat niet mag.
    const paths = [];
    for (const def of bfElements.BF_ELEMENTS) {
        if (def.binding && def.binding.fallback) paths.push(def.binding.fallback);
    }
    assert.ok(paths.length >= 1, 'sanity: het vocabulaire kent een terugval');
    for (const path of paths) {
        assert.match(path, /^bridge_grants\./,
            'een terugval hoort een pad IN de brug-grants te zijn, anders valt hij niet te volgen');
    }

    const slots = { html: '<bf-agent></bf-agent>', css: '', js: '' };
    await withPatches(stubs({ slots, grants: { agent: { agentId: 'ag_from_grants' }, tables: [] } }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.deepStrictEqual(out.uses.targets.agent.map(t => t.id), ['ag_from_grants']);
        assert.strictEqual(out.uses.targets.agent[0].fromPage, true);
    });
});

test('BITE — a page with no agent bound leaves the element unresolved, never a guess', async () => {
    // Geen agent aan de pagina: het chatblok staat er wél, maar er is niets om
    // naar te wijzen. "Onbekend" is dan het antwoord; een willekeurig id uit een
    // andere grant zou er precies zo echt uitzien.
    const slots = { html: '<bf-agent></bf-agent>', css: '', js: '' };
    await withPatches(stubs({ slots, grants: { agent: null, automations: [{ automationId: 'auto_1' }], tables: [] } }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.deepStrictEqual(out.uses.targets.agent, []);
        assert.strictEqual(out.uses.unresolved.length, 1);
        assert.strictEqual(out.uses.unresolved[0].reason, 'page-binding-unknown');
        assert.strictEqual(JSON.stringify(out.uses.targets).includes('auto_1'), false,
            'het id van een andere grant mag nooit als agent worden ingevuld');
    });
});

/**
 * Drift test — keeps the THREE places where the `bf-*` vocabulary lives in step with
 * core/webpages/bfElements.js.
 *
 * ── WHY THIS TEST EXISTS ────────────────────────────────────────────
 *
 * services/reactBundleServer.js has for years carried the rule "⚠️ KEEP IN SYNC with
 * agent-hub/src/utils/buildWebpagePreview.ts … must remain byte-identical", and nothing
 * enforces it. The result is there today: `window.beeflowAI` in reactBundleServer.js has the names
 * `complete`/`ground`/`generate`, which exist in neither of the other two bridge files, and it lacks the four
 * names (`chat`/`chatJSON`/`stream`/`ask`) that are there. A page that calls
 * `beeflowAI.chat(...)` in the headless render gets a
 * TypeError there. A comment line holds nothing back; a test that enumerates does.
 *
 * ── WHAT THIS CAN PROVE ─────────────────────────────────────────────
 *
 * That all three places carry the same NAMES, know the same attributes,
 * and per place pronounce the same JUDGEMENT about what remains of an element — and that
 * nowhere a second, hand-written list has come into being from which the first could drift.
 *
 * ── WHAT THIS CANNOT PROVE ──────────────────────────────────────────
 *
 * That three implementations BEHAVE the same. This test puts lists side by side.
 * Whether the dropdown will actually draw a visibly disabled button instead of an empty
 * spot must be proven by that dropdown itself, with a test on its output.
 *
 * ── THE FOUR LOCKS, AND WHERE THEY ARE CHECKED HERE ─────────────────
 *
 *   (a) the two server places cannot keep a copy           → "no second list"
 *   (b) the public bridge is derived, not declared         → "public bridge"
 *   (c) the vanilla snapshot must decide                   → "vanilla snapshot"
 *       (which moreover bites at require time: assertCoversVocabulary throws)
 *   (d) the client mirror is generated                     → "client mirror"
 *
 * Run: cd server && node --test --test-force-exit core/webpages/bfElements.drift.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bf = require('./bfElements');
const { maskCode } = require('./webpageBindings');
const { buildPublicBridgeScript } = require('../../services/publicBridgeScript');
const { buildStubBridgeScript } = require('../../services/reactBundleServer');
const bfTable = require('../../services/webpageBfTable');

const REPO = path.join(__dirname, '..', '..', '..');
const CLIENT = path.join(REPO, 'agent-hub', 'src', 'utils');
/** De gegenereerde spiegel: de enige plek waar de client het vocabulaire opsomt. */
const MIRROR = path.join(CLIENT, 'bfElements.ts');
/**
 * The client files that should read from the mirror instead of knowing for themselves: the two
 * composers plus the RUNTIME that executes the vocabulary. The latter hung before only on a frontend
 * test; it belongs here too, because this is the place that guards the whole tree.
 */
const CLIENT_COMPOSERS = [
    path.join(CLIENT, 'composeWebpageDocument.ts'),
    path.join(CLIENT, 'buildWebpagePreview.ts'),
    path.join(CLIENT, 'bfElementsRuntime.ts'),
];
/** De twee serverbruggen die het vocabulaire uitzenden, plus hun gedeelde motor. */
const BRIDGE = path.join(REPO, 'server', 'services', 'publicBridgeScript.js');
const STUB_BRIDGE = path.join(REPO, 'server', 'services', 'reactBundleServer.js');
const NOTICE_ENGINE = path.join(REPO, 'server', 'services', 'bfBridgeNotices.js');

/**
 * Every known tag name as a whole word — which a hand-written list gives away.
 *
 * The lookarounds exclude a hyphen, because the frontend already uses CSS classes such as
 * `bf-table-colhead` and a keyframe `bf-form-spin`. Those have nothing to do with the vocabulary
 * and must not give a false alarm.
 */
const TAG_WORD = new RegExp(`(?<![-\\w])(?:${bf.BF_TAGS.join('|')})(?![-\\w])`, 'g');

/** Regeleindes gelijktrekken: de checkout kan CRLF dragen, de generator niet. */
function readSource(file) {
    const raw = fs.readFileSync(file, 'utf8');
    // No claim about behaviour: a sanity guard against a path that silently yields an
    // empty string, after which every comparison below would be vacuously green. The real drift claims in this file run
    // via the other direction — the agent-hub files are not required here (client
    // runtime), and the server bridges are elsewhere in this file REALLY
    // run (buildPublicBridgeScript/buildStubBridgeScript, vm.runInContext).
    assert.ok(raw.length > 500, `sanity: ${path.basename(file)} is gelezen en niet leeg`);
    return raw.replace(/\r\n/g, '\n');
}

/** The generated block from the client mirror, including its markers. */
function mirrorBlock() {
    const src = readSource(MIRROR);
    const start = src.indexOf(bf.CLIENT_MIRROR_BEGIN);
    const end = src.indexOf(bf.CLIENT_MIRROR_END);
    // A renamed marker must go RED, not silently yield an empty section.
    assert.ok(start !== -1, 'agent-hub/src/utils/bfElements.ts draagt de beginmarker van de spiegel');
    assert.ok(end !== -1, 'agent-hub/src/utils/bfElements.ts draagt de eindmarker van de spiegel');
    assert.ok(end > start, 'de eindmarker staat na de beginmarker');
    return { src, start, end, block: src.slice(start, end + bf.CLIENT_MIRROR_END.length) };
}

// ── (d) de client-spiegel ─────────────────────────────────────────────

test('client-spiegel — het blok in agent-hub/src/utils/bfElements.ts IS de registry', () => {
    const { block } = mirrorBlock();
    const expected = bf.renderClientMirror();
    assert.strictEqual(
        block, expected,
        'de gegenereerde spiegel in agent-hub/src/utils/bfElements.ts loopt achter op '
        + 'server/core/webpages/bfElements.js. De preview en een ingelogde lezer krijgen dan een ander '
        + 'vocabulaire dan de publieke snapshot — precies de asymmetrie die W4 dicht. Vervang alles '
        + 'tussen de twee markers (inclusief de markers) door de uitvoer van:\n'
        + '  cd server && node -e "console.log(require(\'./core/webpages/bfElements\').renderClientMirror())"',
    );
});

test('client-spiegel — elk element uit de registry staat er ook echt in', () => {
    // Second direction, with its own extraction: if the equality test above
    // ever matched an empty string against an empty string, the sanity assert here
    // catches that anyway.
    const { block } = mirrorBlock();
    const named = new Set(block.match(TAG_WORD) || []);
    assert.ok(named.size > 3, 'sanity: er zijn tagnamen uit de spiegel gehaald');
    assert.deepStrictEqual([...named].sort(), [...bf.BF_TAGS].sort(),
        'de spiegel noemt precies het vocabulaire — niet meer en niet minder');
});

test('geen tweede lijst — de spiegel bevat niets BUITEN het gegenereerde blok', () => {
    const { src, start, end } = mirrorBlock();
    const outside = src.slice(0, start) + src.slice(end + bf.CLIENT_MIRROR_END.length);
    const strays = outside.match(TAG_WORD) || [];
    assert.deepStrictEqual(strays, [],
        'agent-hub/src/utils/bfElements.ts noemt een bf-element buiten het gegenereerde blok om; alles wat '
        + 'daar staat, ontsnapt aan de vergelijking met de registry');
});

test('geen tweede lijst — de client-composers weten zelf geen tagnaam', () => {
    // Both composers must read from ./bfElements.js. If one of them writes a
    // name itself, there is a second list — and that is exactly how the
    // beeflowAI surface of reactBundleServer.js got out of step.
    for (const file of CLIENT_COMPOSERS) {
        const src = readSource(file);
        const strays = (maskCode(src).literals
            .map(l => String(l.value || '').match(TAG_WORD) || [])
            .flat());
        assert.deepStrictEqual(strays, [],
            `${path.basename(file)} schrijft een bf-tagnaam op in plaats van hem uit BF_ELEMENTS te lezen`);
    }
});

// ── (b) de publieke brug + (a) geen tweede lijst ──────────────────────

/**
 * Every place where a BRIDGE broadcasts the vocabulary, with the builder next to it.
 *
 * Two, and that is the core of the repair this round made: the bridge from
 * publicBridgeScript.js is ONLY injected when the author has turned on public AI
 * (default off), while the stub from reactBundleServer.js sits in EVERY react document — the public share and the picture that the builder-AI sees.
 * Without this second row the honest-failure mechanism was dead code on the default path.
 */
const BRIDGES = [
    ['publieke AI-brug (reactShare)', 'reactShare',
        () => buildPublicBridgeScript({ token: 't0ken', apiBase: 'https://example.test' })],
    ['ingebakken stub (reactShare)', 'reactShare',
        () => buildStubBridgeScript('reactShare')],
    ['ingebakken stub (headlessRender)', 'headlessRender',
        () => buildStubBridgeScript('headlessRender')],
];

test('elke brug noemt elk element, met de weigering van ZIJN eigen plek erbij', () => {
    for (const [label, surface, build] of BRIDGES) {
        const script = build();
        const vocab = bf.bridgeVocabulary(surface);
        const named = new Set(script.match(/(?<![-\w])bf-[a-z][a-z0-9-]*(?![-\w])/g) || []);
        assert.ok(named.size >= bf.BF_TAGS.length, `sanity: ${label} noemt bf-elementen`);
        for (const tag of bf.BF_TAGS) {
            assert.ok(named.has(tag),
                `${label} zwijgt over ${tag}; een pagina die hem gebruikt krijgt daar stilte in plaats van een reden`);
            assert.ok(script.includes(vocab[tag].message),
                `${label}: de weigering van ${tag} ("${vocab[tag].message}") staat er niet in`);
            assert.ok(script.includes(vocab[tag].notice),
                `${label}: de LEZER krijgt bij ${tag} geen zin te zien; dan is een dood element niet te `
                + 'onderscheiden van een leeg element');
        }
        const unknown = [...named].filter(t => !bf.isKnownBfTag(t));
        assert.deepStrictEqual(unknown, [], `${label} noemt elementen die de registry niet kent`);
    }
});

test('de twee plekken lenen elkaars zin NIET', () => {
    // The same stub serves the public share and the picture of the author's own page.
    // "on a shared link" would be a lie there about a page that works normally
    // when logged in, so each place carries its own text.
    const share = bf.bridgeVocabulary('reactShare');
    const render = bf.bridgeVocabulary('headlessRender');
    for (const tag of bf.BF_TAGS) {
        assert.notStrictEqual(share[tag].notice, render[tag].notice,
            `${tag} draagt op beide plekken dezelfde zin; dan zegt er een van de twee iets onwaars`);
    }
    const doc = buildStubBridgeScript('headlessRender');
    for (const tag of bf.BF_TAGS) {
        assert.ok(!doc.includes(share[tag].notice),
            `de stub voor het plaatje draagt de zin van de gedeelde link bij ${tag}`);
    }
});

test('publieke brug — de uitgezonden brug noemt elk element, met zijn weigering erbij', () => {
    const script = buildPublicBridgeScript({ token: 't0ken', apiBase: 'https://example.test' });
    // The same lookarounds as TAG_WORD above, and for the same reason: `\b`
    // sees a hyphen as a word boundary, so an ATTRIBUTE name such as
    // `data-bf-state` (the marking the bridge puts on a refused element,
    // and which the client runtime also uses) would be taken for "unknown element bf-state".
    // An attribute name is not a tag name.
    const named = new Set(script.match(/(?<![-\w])bf-[a-z][a-z0-9-]*(?![-\w])/g) || []);
    assert.ok(named.size >= bf.BF_TAGS.length, 'sanity: de brug noemt bf-elementen');

    for (const tag of bf.BF_TAGS) {
        assert.ok(named.has(tag),
            `de publieke brug zwijgt over ${tag}; een pagina die hem gebruikt krijgt daar stilte in plaats `
            + 'van een reden');
        const message = bf.publicShareVocabulary()[tag].message;
        assert.ok(script.includes(message),
            `de weigering van ${tag} ("${message}") staat niet in de uitgezonden brug — een weigering `
            + 'zonder reden is niet te onderscheiden van "het werkte gewoon niet"');
    }

    // Andere richting: alles wat de brug bf-noemt, bestaat ook.
    const unknown = [...named].filter(t => !bf.isKnownBfTag(t));
    assert.deepStrictEqual(unknown, [],
        'de publieke brug noemt elementen die core/webpages/bfElements.js niet kent');
});

/**
 * RUN the broadcast bridge, in a sandbox with just enough browser around it.
 *
 * The bridge is generated text, and a regex over it only says that there is a
 * line there that looks right. What the page notices is what `beeflowBf`
 * ANSWERS — so the script is executed here and queried.
 */
function runBridge(script) {
    const code = script.replace(/^[\s\S]*?<script[^>]*>/, '').replace(/<\/script>\s*$/, '');
    const document = {
        nodeType: 9, readyState: 'complete',
        addEventListener() {}, querySelectorAll() { return []; },
    };
    // No customElements: the define loop is not what is asked for here, and
    // a half element registration would only add noise.
    const sandbox = { document, fetch: async () => ({ ok: true, json: async () => ({}) }) };
    sandbox.window = sandbox;
    vm.runInContext(code, vm.createContext(sandbox));
    return sandbox.window;
}

test('publieke brug — een onbekend element komt er als "unknown" uit, niet als in orde', () => {
    const bridge = runBridge(buildPublicBridgeScript({ token: 't0ken', apiBase: 'https://example.test' }));

    assert.strictEqual(bridge.beeflowBf.state('bf-nope'), 'unknown',
        'een tag die het vocabulaire niet kent is herkenbaar onbekend, nooit stilzwijgend in orde');
    assert.strictEqual(bridge.beeflowBf.reason('bf-nope'), 'Unknown Bee Flow element bf-nope',
        'en de reden spreekt dat uit in plaats van null terug te geven');

    // The counter-proof: an element that the bridge DOES know carries the judgement of
    // this place, not 'unknown'. Without this line a bridge that says 'unknown' everywhere
    // would be green above.
    for (const [tag, entry] of Object.entries(bf.bridgeVocabulary('reactShare'))) {
        assert.strictEqual(bridge.beeflowBf.state(tag), entry.state, `${tag} draagt het oordeel van reactShare`);
        assert.strictEqual(bridge.beeflowBf.reason(tag), entry.message, `${tag} zegt ook waarom`);
    }
});

test('geen tweede lijst — geen enkel brugbestand schrijft zelf een tagnaam', () => {
    for (const file of [BRIDGE, STUB_BRIDGE, NOTICE_ENGINE]) {
        const src = readSource(file);
        const strays = src.match(TAG_WORD) || [];
        assert.deepStrictEqual(
            strays, [],
            `${path.basename(file)} noemt een bf-element met de hand. Dit bestand hoort zijn lijst volledig `
            + 'uit bridgeVocabulary() te halen; alles wat hier met de hand staat, kan achterlopen.',
        );
    }
});

test('de bruggen delen ÉÉN motor — er is geen tweede kopie van het mechanisme', () => {
    // The decoration mechanism was at first only in publicBridgeScript.js. When
    // it turned out the stub had to have it too, copying it over was the obvious mistake — and precisely the drift this file fights.
    const engine = readSource(NOTICE_ENGINE);
    assert.ok(engine.includes('function bfDecorate'),
        'sanity: de motor draagt het decoratiemechanisme');
    for (const file of [BRIDGE, STUB_BRIDGE]) {
        const src = readSource(file);
        assert.ok(src.includes("require('./bfBridgeNotices')"),
            `${path.basename(file)} haalt het mechanisme niet uit de gedeelde motor`);
        assert.ok(!src.includes('function bfDecorate'),
            `${path.basename(file)} draagt een eigen kopie van het decoratiemechanisme`);
    }
});

test('elke brug-plek uit de registry heeft ook echt een brug', () => {
    // The other direction: adding a place to BRIDGE_SURFACES without having it
    // broadcast here would yield a place whose texts end up nowhere — visible in the
    // registry, invisible on the page.
    const covered = new Set(BRIDGES.map(([, surface]) => surface));
    assert.deepStrictEqual([...covered].sort(), [...bf.BRIDGE_SURFACES].sort(),
        'BRIDGE_SURFACES en de bruggen die deze test bouwt lopen uit elkaar');
});

// ── (c) de vanilla snapshot ───────────────────────────────────────────

test('vanilla snapshot — webpageBfTable spreekt zich over ELK element uit', () => {
    const handling = bfTable.VANILLA_HANDLING;
    assert.ok(handling, 'sanity: de handelingstabel wordt geëxporteerd');
    assert.deepStrictEqual([...Object.keys(handling)].sort(), [...bf.BF_TAGS].sort(),
        'de vanilla snapshot noemt precies het vocabulaire — een element dat hier ontbreekt verdwijnt stil, '
        + 'want DOMPurify pakt een onbekend element zonder waarschuwing uit');

    for (const [tag, verdict] of Object.entries(handling)) {
        assert.ok(['expand', 'inert'].includes(verdict),
            `${tag}: "${verdict}" is geen geldige beslissing (expand of inert)`);
    }
    // What JS needs CANNOT be expanded there; what it does not need
    // must not be written away as inert. The action table may therefore not
    // contradict the vocabulary.
    for (const tag of bf.tagsNeedingJs()) {
        assert.notStrictEqual(handling[tag], 'expand',
            `${tag} heeft JS nodig; in een script-vrije snapshot valt daar niets aan uit te klappen`);
    }
    // Sanity: the table is the oldest expander and the only one this test knows by
    // name. If something else is here, the expander has broken.
    assert.strictEqual(handling['bf-table'], 'expand',
        'bf-table hoort server-side te worden uitgeklapt');
});

test('vanilla snapshot — het require-tijd-slot bijt echt', () => {
    // Not the table of webpageBfTable itself: that would be the same thing once more.
    // This tests the MECHANISM by which that module no longer loads as soon as
    // someone adds an element without saying anything about it there.
    assert.throws(
        () => bf.assertCoversVocabulary('services/webpageBfTable (vanilla snapshot)', ['bf-table']),
        /webpageBfTable/,
        'een onvolledige handelingstabel moet de module laten vastlopen, niet stil doorgaan',
    );
});

test('vanilla snapshot — wat JS nodig heeft staat nergens als "uitklapbaar" opgeschreven', () => {
    // The rule itself, seen here from the consumer's side: in the vanilla
    // snapshot no JS runs, so no element with needsJs may carry any state there other than
    // 'inert' — and 'inert' must have visible text, otherwise the inertness is exactly as silent as DOMPurify makes it.
    for (const tag of bf.tagsNeedingJs()) {
        const vanilla = bf.getBfElement(tag).surfaces.vanillaSnapshot;
        assert.strictEqual(vanilla.state, 'inert', `${tag} kan in een script-vrije snapshot niets doen`);
        assert.ok(vanilla.notice && vanilla.notice.length > 10,
            `${tag} moet in de snapshot ZICHTBAAR melden dat hij niet werkt`);
    }
    assert.ok(bf.tagsNeedingJs().length >= 3, 'sanity: er zijn elementen die JS nodig hebben');
});

// ── het vocabulaire zelf blijft één lijst ─────────────────────────────

test('de registry is de enige plek in de serverbron die een tagnaam opschrijft', () => {
    // A sweep over the whole server side. Only STRING LITERALS count: a
    // tag name in a comment is documentation, a tag name in code is a list.
    // An identifier cannot carry a hyphen, so in JS a tag CAN only be in
    // a string — the distinction is therefore complete.
    //
    // The separation is done with the masker from webpageBindings.js, which W3
    // explicitly exports for this purpose. Its known blind spot (a regex literal with a quote
    // in it) can here only give a FALSE ALARM, never a missed case: it sees too much as string, not too little.
    const allowed = new Map([
        ['core/webpages/bfElements.js', 'de registry zelf — hier hoort het vocabulaire te staan'],
        ['services/webpageBfTable.js', 'de handelingstabel die deze consument MOET uitspreken'],
        // Both below are written by .claude/handoff/curriculum/generate.mjs from the
        // lessons. The tag names stand there in PROSE for the reader ("the five Studio
        // elements are bf-table, …"), not in a list that code reads: if such a
        // name lags behind, that is an outdated lesson text, not a second
        // vocabulary. Updating happens in the lesson, then generate.mjs.
        ['i18n/defaults/en/learn.js', 'vertaalkopij — de gegenereerde learn.*-lesteksten noemen de elementen bij naam'],
        ['learning/catalog.generated.js', 'gegenereerd uit de curriculum-lessen — lesinhoud (rubrics), geen lijst die code leest'],
    ]);
    const server = path.join(REPO, 'server');
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            // Testbestanden schrijven met opzet fixtures met echte tags in.
            if (!/\.(js|mjs|cjs)$/.test(entry.name) || /\.test\.(js|mjs|cjs)$/.test(entry.name)) continue;
            const rel = path.relative(server, full).split(path.sep).join('/');
            if (allowed.has(rel)) continue;
            const text = fs.readFileSync(full, 'utf8');
            TAG_WORD.lastIndex = 0;
            if (!TAG_WORD.test(text)) continue;
            TAG_WORD.lastIndex = 0;
            const hits = new Set();
            for (const literal of maskCode(text).literals) {
                for (const hit of String(literal.value || '').match(TAG_WORD) || []) hits.add(hit);
            }
            if (hits.size) offenders.push(`${rel} (${[...hits].join(', ')})`);
        }
    };
    walk(server);
    assert.deepStrictEqual(
        offenders, [],
        'deze serverbestanden schrijven een bf-tagnaam in code op. Elke zo\'n plek is een tweede lijst die kan '
        + 'achterlopen op core/webpages/bfElements.js; lees de naam daaruit, of zet het bestand bewust op de '
        + '`allowed`-lijst hierboven met de reden erbij.',
    );
    // Without this line a broken masker or a wrong path would produce a
    // green test that has read nothing.
    assert.ok(
        maskCode(fs.readFileSync(path.join(server, 'services', 'webpageBfTable.js'), 'utf8'))
            .literals.some(l => String(l.value || '').includes('bf-table')),
        'sanity: de sweep vindt een tagnaam in een bestand waarvan we weten dat hij er staat',
    );
});

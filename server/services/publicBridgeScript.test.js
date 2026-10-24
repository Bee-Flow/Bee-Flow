/**
 * publicBridgeScript — the server twin for react-mui public shares.
 *
 * ── WHY A DRIFT TEST IS HERE ────────────────────────────────────────
 *
 * This file is a HAND-MAINTAINED twin of the client bridge in agent-hub/src/utils/composeWebpageDocument.js.
 * Its neighbour services/reactBundleServer.js has carried the same agreement in its comments for years —
 * "⚠️ KEEP IN SYNC with buildWebpagePreview.js … byte-identical" — and it is right there that the proof
 * lies that a comment line holds nothing back: `window.beeflowAI` there has the names `complete`/`ground`/`generate`,
 * which exist in neither of the other two bridge files, and it lacks the four names that ARE there. A page
 * that calls `beeflowAI.chat(...)` gets a TypeError there.
 *
 * The tests below make that agreement mechanical, at two levels:
 *
 *   1. the bf ELEMENT VOCABULARY — the bridge emits what core/webpages/bfElements.js says, FIELD BY FIELD. Not a
 *      count: a test that only checks HOW MANY elements there are stays green when someone adds an attribute and
 *      forgets the projection;
 *   2. the BRIDGE SURFACE — which `window.beeflow*` names each half carries. Every difference is in one table,
 *      with the reason next to it, and that table is checked against BOTH sources.
 *
 * ── WHAT THIS CAN PROVE ─────────────────────────────────────────────
 *
 * That the emitted bridge carries the same elements, the same attributes and the same judgements as the registry;
 * that every refused element in a real document visibly reports what cannot be done; and that neither half of the
 * twin can silently gain or lose a name.
 *
 * ── WHAT THIS CANNOT PROVE ──────────────────────────────────────────
 *
 * That the two halves BEHAVE the same. The same name can do something different on each side; these tests compare
 * shapes and, where it concerns the refusal, what lands in the DOM. They say nothing about the route behind it.
 * And they say nothing about a share where public AI is OFF: then this bridge is not injected at all and only the
 * baked-in stub of reactBundleServer.js runs (see the report at this step).
 *
 * Run: cd server && node --test --test-force-exit services/publicBridgeScript.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { buildPublicBridgeScript } = require('./publicBridgeScript');
const { buildStubBridgeScript } = require('./reactBundleServer');
const bf = require('../core/webpages/bfElements');
const { maskCode } = require('../core/webpages/webpageBindings');

/**
 * The CLIENT half of the twin. Two files, because the client bridge is split: the platform bridges are built in
 * the composer, the element vocabulary in its own runtime. Both must exist — if one moves, this test should turn
 * red and not quietly read only half.
 */
const CLIENT_UTILS = path.join(__dirname, '..', '..', 'agent-hub', 'src', 'utils');
const CLIENT_BRIDGE_FILES = [
    // De platformbruggen staan in server/shared/webpage/; dit is de gegenereerde spiegel die de client laadt.
    path.join(__dirname, '..', '..', 'agent-hub', 'src', 'shared', 'webpage', 'previewBridges.mjs'),
    path.join(CLIENT_UTILS, 'bfElementsRuntime.ts'),
];

/** The bridge as it is really emitted. One place, so that every test checks the same thing. */
function bridge() {
    return buildPublicBridgeScript({ token: 't0ken', apiBase: 'https://example.test' });
}

// ── de bestaande vorm-regressies ──────────────────────────────────────

test('bakes the token and points BASE at /api/public-share', () => {
    const s = buildPublicBridgeScript({ token: 'tok-123', apiBase: 'https://beeflow.nl/' });
    assert.match(s, /var TOKEN = "tok-123";/);
    // trailing slash trimmed, /api/public-share appended
    assert.match(s, /var BASE = "https:\/\/beeflow\.nl\/api\/public-share";/);
    // real AI surface exposed
    assert.match(s, /window\.beeflowAI = \{/);
    assert.match(s, /chat:/);
    assert.match(s, /stream:/);
});

test('side-effecting bridges are stubbed and ask is refused', () => {
    const s = buildPublicBridgeScript({ token: 't', apiBase: 'http://localhost:3101' });
    assert.match(s, /window\.beeflowDB =/);
    assert.match(s, /window\.beeflowAutomations =/);
    assert.match(s, /window\.beeflowIntegrations =/);
    assert.match(s, /ask is not available on shared links/);
});

test('beeflowTables refuses on a public share, and does not resolve empty', () => {
    const s = buildPublicBridgeScript({ token: 't', apiBase: 'http://localhost:3101' });
    assert.match(s, /window\.beeflowTables = \{/);
    assert.match(s, /beeflowTables is not available on shared links/);
    // "No rows" and "you cannot read a table here" must not read the same: a resolve-empty stub would make a public
    // page show an empty table as if the table were empty.
    assert.strictEqual(/beeflowTables = \{ query:function\(\)\{return Promise\.resolve/.test(s), false);
});

test('is a single self-contained, properly-closed script element', () => {
    const s = buildPublicBridgeScript({ token: 't', apiBase: 'http://x' });
    assert.ok(s.startsWith('<script>'));
    assert.ok(s.trimEnd().endsWith('</script>'));
    // Exactly one opening and one closing tag — no stray inner </script> that
    // would truncate the element when parsed inside the document.
    assert.strictEqual((s.match(/<script>/g) || []).length, 1);
    assert.strictEqual((s.match(/<\/script>/g) || []).length, 1);
});

// ── 1. THE VOCABULARY: THE SHAPE, NOT A COUNT ─────────────────────────

/**
 * The shape that the bridge should emit — derived SEPARATELY here from the registry.
 *
 * Deliberately not calling `publicShareVocabulary()`: then the test would compare that function with itself and
 * stay green everywhere. This is a second, hand-written derivation from the same source; if the emission deviates
 * from it, then something is broken between registry and bridge.
 */
function expectedVocabulary() {
    const out = {};
    for (const def of bf.BF_ELEMENTS) {
        const share = def.surfaces.reactShare;
        out[def.tag] = {
            summary: def.summary,
            needsJs: def.needsJs,
            // `reads` appears only on elements that have one — the projection simply leaves out a field that the
            // element does not carry.
            ...(def.reads !== undefined ? { reads: def.reads } : {}),
            attributes: def.attributes.map((a) => {
                // Only the fields that mean something to a BROWSER. `means` names internal gate paths and stays on the server.
                const attr = { name: a.name, required: a.required };
                if (a.aliases !== undefined) attr.aliases = [...a.aliases];
                if (a.values !== undefined) attr.values = [...a.values];
                if (a.default !== undefined) attr.default = a.default;
                if (a.max !== undefined) attr.max = a.max;
                if (a.requiredWhen !== undefined) attr.requiredWhen = { ...a.requiredWhen };
                return attr;
            }),
            state: share.state,
            message: share.message === undefined ? null : share.message,
            notice: share.notice === undefined ? null : share.notice,
        };
    }
    return out;
}

/**
 * The document as a public react share receives it: the bridge in `<head>`, then the markup. Waits for
 * DOMContentLoaded, because the sweep over what was already in the document hangs on that.
 */
async function renderWithBridge(bodyHtml, { withBridge = true, headExtra = '' } = {}) {
    const dom = new JSDOM(
        `<!DOCTYPE html><html><head>${headExtra}${withBridge ? bridge() : ''}</head>`
        + `<body>${bodyHtml}</body></html>`,
        { runScripts: 'dangerously' },
    );
    await new Promise((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', resolve, { once: true });
    });
    return dom;
}

test('drift — de uitgezonden brug draagt de VORM van de registry, veld voor veld', async () => {
    const dom = await renderWithBridge('');
    try {
        const w = dom.window;
        assert.ok(w.beeflowBf, 'sanity: de brug heeft window.beeflowBf gezet');
        // Over de realm-grens heen: JSDOM-objecten hebben een ander
        // Object.prototype, en deepStrictEqual vergelijkt prototypes mee.
        const shipped = JSON.parse(JSON.stringify(w.beeflowBf.elements));

        assert.ok(Object.keys(shipped).length > 3, 'sanity: er is een vocabulaire uitgezonden');
        assert.deepStrictEqual(
            shipped, expectedVocabulary(),
            'de publieke brug zendt een ANDER vocabulaire uit dan core/webpages/bfElements.js beschrijft. '
            + 'Een react-share krijgt dan andere elementen, andere attributen of een ander oordeel dan de '
            + 'preview en de vanilla snapshot — precies de asymmetrie die W4 dicht. Kijk naar '
            + 'publicShareVocabulary() en naar PUBLIC_SHARE_PROJECTION.',
        );
    } finally { dom.window.close(); }
});

test('drift — elk VELD van het vocabulaire is bewust wel of niet verzonden', () => {
    // This is the slot through which a new ATTRIBUTE cannot silently stay behind. A test that only counts elements
    // does not see such an addition; this one lays every key that occurs in the registry beside the projection table.
    const used = { element: new Set(), surface: new Set(), attribute: new Set() };
    for (const def of bf.BF_ELEMENTS) {
        for (const key of Object.keys(def)) used.element.add(key);
        for (const key of Object.keys(def.surfaces.reactShare)) used.surface.add(key);
        for (const attr of def.attributes) for (const key of Object.keys(attr)) used.attribute.add(key);
    }
    // Without this line a broken walk would produce a green test that has read nothing.
    assert.ok(used.element.size >= 5 && used.attribute.size >= 4,
        'sanity: er zijn velden uit de registry gehaald');

    for (const level of ['element', 'surface', 'attribute']) {
        const { ship, hold } = bf.PUBLIC_SHARE_PROJECTION[level];
        const decided = new Set([...ship, ...Object.keys(hold)]);

        // Richting 1 — alles wat de registry gebruikt, is beslist.
        const undecided = [...used[level]].filter(k => !decided.has(k));
        assert.deepStrictEqual(undecided, [],
            `PUBLIC_SHARE_PROJECTION.${level} zegt niets over ${undecided.join(', ')}. Zo'n veld gaat stil `
            + 'niet mee naar de publieke share, en dan draagt de tweeling niet meer dezelfde definitie.');

        // Direction 2 — everything that the table names also exists. A typo in `ship` would otherwise leave a field
        // silently at home.
        const phantom = [...decided].filter(k => !used[level].has(k));
        assert.deepStrictEqual(phantom, [],
            `PUBLIC_SHARE_PROJECTION.${level} noemt ${phantom.join(', ')}, en dat veld bestaat nergens in het `
            + 'vocabulaire — waarschijnlijk een verschrijving, en dan blijft het echte veld thuis.');

        // A field cannot be sent and stay at home at the same time; if it could, the table would say nothing any more.
        const both = ship.filter(k => Object.prototype.hasOwnProperty.call(hold, k));
        assert.deepStrictEqual(both, [], `${level}: ${both.join(', ')} staat in ship én in hold`);

        // A reason for keeping something at home is not optional: "why not" is exactly what a next reader must be able to check.
        for (const [key, why] of Object.entries(hold)) {
            assert.ok(typeof why === 'string' && why.length > 20,
                `${level}.${key} blijft op de server zonder leesbare reden`);
        }
    }
});

test('drift — wat de projectie thuislaat, staat ook echt niet in de uitzending', async () => {
    // The table beside the OUTPUT, not beside itself. This test found a real gap: `attributes` was passed separately,
    // outside the ship list, so the table could say "stays at home" while the field travelled along anyway.
    const dom = await renderWithBridge('');
    try {
        const shipped = JSON.parse(JSON.stringify(dom.window.beeflowBf.elements));
        const entries = Object.values(shipped);
        assert.ok(entries.length > 3, 'sanity: er is een vocabulaire uitgezonden');

        const elementHold = Object.keys(bf.PUBLIC_SHARE_PROJECTION.element.hold);
        const surfaceHold = Object.keys(bf.PUBLIC_SHARE_PROJECTION.surface.hold);
        const attributeHold = Object.keys(bf.PUBLIC_SHARE_PROJECTION.attribute.hold);
        assert.ok(elementHold.length && surfaceHold.length && attributeHold.length,
            'sanity: er is op elk niveau iets dat thuisblijft');

        for (const entry of entries) {
            for (const key of [...elementHold, ...surfaceHold]) {
                assert.ok(!(key in entry),
                    `"${key}" reist mee naar de bron van een publieke pagina terwijl PUBLIC_SHARE_PROJECTION `
                    + 'zegt dat het op de server blijft. Ofwel de brug omzeilt de tabel, ofwel de tabel is '
                    + 'verouderd — in beide gevallen zegt de tabel niets meer.');
            }
            for (const attr of entry.attributes || []) {
                for (const key of attributeHold) {
                    assert.ok(!(key in attr), `attribuutveld "${key}" reist mee terwijl het thuis hoort te blijven`);
                }
            }
        }
    } finally { dom.window.close(); }
});

test('BIJT — een veld dat de projectie niet kent, laat de brug niet meer bouwen', () => {
    // The mechanism itself, with an invented element: the real registry is frozen, so the test cannot mutate it.
    // This is the require-time slot that makes "forgotten" no option.
    assert.strictEqual(bf.assertProjectionComplete(), true, 'het echte vocabulaire is volledig beslist');

    const invented = [{
        tag: 'bf-ghost',
        summary: 'x',
        needsJs: false,
        tooltip: 'een nieuw veld dat niemand in de projectie heeft gezet',
        attributes: [{ name: 'a', required: true, placeholder: 'idem, maar op een attribuut' }],
        surfaces: { reactShare: { state: 'refused', badge: 'en nog een, op de plek' } },
    }];
    assert.throws(
        () => bf.assertProjectionComplete(invented),
        (err) => {
            for (const expected of ['bf-ghost.tooltip', 'bf-ghost[a].placeholder', 'bf-ghost.surfaces.reactShare.badge']) {
                assert.ok(err.message.includes(expected), `de melding wijst ${expected} aan`);
            }
            return true;
        },
    );
});

test('drift — een onbekend element komt er als "unknown" uit, met een reden', async () => {
    const dom = await renderWithBridge('');
    try {
        const { beeflowBf } = dom.window;
        // Hoofdletterongevoelig, want zo staat het in de DOM (tagName is hoofdletters).
        assert.strictEqual(beeflowBf.state('BF-TABLE'), 'refused');
        assert.strictEqual(beeflowBf.state('bf-nope'), 'unknown',
            'een tag die het vocabulaire niet kent, mag nooit als een bekende toestand terugkomen');
        assert.match(beeflowBf.reason('bf-nope'), /Unknown Bee Flow element bf-nope/);
        assert.strictEqual(beeflowBf.lookup('bf-nope'), null, 'geen lege definitie voor iets dat niet bestaat');
    } finally { dom.window.close(); }
});

// ── 2. EERLIJK FALEN: DE WEIGERING IS TE ZIEN ─────────────────────────

/**
 * The elements that do NOT work themselves at this place — from the registry.
 *
 * NOT `=== 'refused'`. An element that legitimately shifts to `inert` would then silently drop out of every DOM
 * test in this file, and on the share become an empty box again without a single test protesting. The bridge marks
 * everything that is not `live` here and not already replaced by the snapshot writer (`static`); this helper asks
 * the same question.
 */
function silentTags() {
    return bf.BF_TAGS.filter((tag) => {
        const state = bf.getBfElement(tag).surfaces.reactShare.state;
        return state !== 'live' && state !== 'static';
    });
}
/** Historische naam, zodat de bestaande tests hieronder leesbaar blijven. */
const refusedTags = silentTags;

test('de te markeren elementen zijn PRECIES wat de registry over deze plek zegt', () => {
    // A lower bound ("there are at least three") let an element silently drop out of the set being walked. Hence exact
    // equality, in both directions.
    const expected = bf.BF_TAGS.filter((tag) => {
        const state = bf.getBfElement(tag).surfaces.reactShare.state;
        return state !== 'live' && state !== 'static';
    });
    assert.deepStrictEqual([...silentTags()].sort(), [...expected].sort());
    assert.ok(expected.length > 0, 'sanity: er valt hier iets te markeren');
    // En de uitgezonden brug markeert ze ook echt allemaal.
    const script = bridge();
    for (const tag of expected) assert.ok(script.includes(tag), `${tag} staat niet in de uitgezonden brug`);
});

test('elk geweigerd element zegt in de DOM wat er niet kan, in plaats van leeg te blijven', async () => {
    const tags = refusedTags();
    assert.ok(tags.length >= 3, 'sanity: er zijn geweigerde elementen om te toetsen');

    const dom = await renderWithBridge('');
    try {
        const { document } = dom.window;
        for (const tag of tags) {
            // createElement + appendChild, because that is how an element on a react share ends up in the document: React
            // builds the DOM itself.
            const el = document.createElement(tag);
            document.body.appendChild(el);

            const notice = bf.getBfElement(tag).surfaces.reactShare.notice;
            assert.ok(notice, `${tag} draagt een tekst voor de lezer in het vocabulaire`);
            assert.ok(
                el.textContent.includes(notice),
                `${tag} laat een lezer met een leeg vak achter. Een leeg vak leest als "er is niets", en dat is `
                + 'iets anders dan "dit kan hier niet" — dezelfde regel waarom beeflowTables weigert in plaats '
                + 'van een lege lijst te geven.',
            );
            assert.strictEqual(el.getAttribute('data-bf-state'), 'refused');
        }
    } finally { dom.window.close(); }
});

test('BIJT — zonder deze brug is datzelfde element wél een leeg vak', async () => {
    // Negative control. Without this test, the test above could stay green on something that the bridge does not do at all.
    const tag = refusedTags()[0];
    const dom = await renderWithBridge('', { withBridge: false });
    try {
        const el = dom.window.document.createElement(tag);
        dom.window.document.body.appendChild(el);
        assert.strictEqual(el.textContent, '', 'sanity: zonder brug blijft het element leeg — dat is het probleem');
        assert.strictEqual(el.getAttribute('data-bf-state'), null);
    } finally { dom.window.close(); }
});

test('wat al in de pagina stond wordt ook opgehaald, en de melding komt maar één keer', async () => {
    const tag = refusedTags()[0];
    const notice = bf.getBfElement(tag).surfaces.reactShare.notice;
    // Written into the document before the bridge was ready: the custom-element hook does not fire everywhere for that,
    // so a sweep must happen as well.
    const dom = await renderWithBridge(`<${tag} source="tbl_1"></${tag}>`);
    try {
        const { document } = dom.window;
        const el = document.querySelector(tag);
        assert.ok(el, 'sanity: het element staat in het document');
        assert.ok(el.textContent.includes(notice), 'ook een element uit de opmaak zelf meldt zijn weigering');
        assert.strictEqual(document.querySelectorAll('[data-bf-notice]').length, 1);

        // Re-inserting fires the hook once more; two notices in
        // one element would be genuinely confusing.
        el.remove();
        document.body.appendChild(el);
        assert.strictEqual(el.querySelectorAll('[data-bf-notice]').length, 1,
            'de melding is idempotent — een verplaatst element krijgt er geen tweede bij');
    } finally { dom.window.close(); }
});

test('de eigen inhoud van de auteur blijft staan naast de melding', async () => {
    const tags = refusedTags();
    const dom = await renderWithBridge(tags.map(t => `<${t}>Mijn eigen tekst</${t}>`).join(''));
    try {
        for (const tag of tags) {
            const el = dom.window.document.querySelector(tag);
            assert.ok(el.textContent.includes('Mijn eigen tekst'),
                `${tag}: de melding wist de inhoud van de auteur niet — een knoplabel is van hem, niet van ons`);
            assert.ok(el.textContent.includes(bf.getBfElement(tag).surfaces.reactShare.notice));
        }
    } finally { dom.window.close(); }
});

test('BIJT — elke melding zegt WAT er niet kan, en is geen ontwikkelaarstekst', () => {
    for (const tag of refusedTags()) {
        const share = bf.getBfElement(tag).surfaces.reactShare;
        assert.ok(share.notice && share.notice.length > 15, `${tag}: de lezer krijgt een hele zin te zien`);
        // "It didn't work" is not a message. It has to say THAT it can't work here;
        // otherwise the message is as meaningless as an empty box.
        assert.match(share.notice, /\bcannot\b|\bis not available\b/,
            `${tag}: de melding zegt niet wat er niet kan`);
        // De tekst voor de LEZER draagt geen tagnamen; die horen in `message`,
        // dat in de console terechtkomt.
        assert.ok(!share.notice.includes(tag),
            `${tag}: een lezer hoeft onze tagnamen niet te kennen — zet die in message, niet in notice`);
        assert.ok(share.message.includes(tag),
            `${tag}: message is de ONTWIKKELAARStekst en hoort de tagnaam juist wél te noemen`);
    }
});

test('refresh() haalt op wat de hook nooit gezien heeft', async () => {
    const tag = refusedTags()[0];
    const dom = await renderWithBridge('');
    try {
        const w = dom.window;
        // A DISCONNECTED branch: connectedCallback never fires here, because
        // nothing is attached to the document. This is the escape hatch for code that
        // builds its markup first and only inserts it later.
        const holder = w.document.createElement('div');
        holder.appendChild(w.document.createElement(tag));
        assert.strictEqual(holder.textContent, '', 'sanity: los van het document is er nog niets gemeld');

        assert.strictEqual(w.beeflowBf.refresh(holder), 1, 'refresh meldt hoeveel elementen hij heeft opgehaald');
        assert.ok(holder.textContent.includes(bf.getBfElement(tag).surfaces.reactShare.notice));
        assert.strictEqual(w.beeflowBf.refresh(holder), 0, 'een tweede keer valt er niets meer op te halen');
    } finally { dom.window.close(); }
});

test('de pagina die zelf een element definieert, wordt niet overschreven', async () => {
    const tag = refusedTags()[0];
    // A second customElements.define on the same name THROWS. If the bridge did not
    // catch that, one self-built element would drag the whole bridge down with it — no
    // beeflowAI, no beeflowTables, nothing.
    const own = `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement {});<\/script>`;
    const dom = await renderWithBridge(`<${tag}></${tag}>`, { headExtra: own });
    try {
        const w = dom.window;
        assert.ok(w.beeflowBf, 'de brug is heel gebleven, ondanks de bezette naam');
        assert.strictEqual(typeof w.beeflowAI.chat, 'function', 'en het AI-oppervlak staat er nog');
        // THE TWO ASSERTS THAT WOULD FEEL THE THROW. beeflowBf and beeflowAI
        // are set BEFORE the define loop and survive an exception regardless; everything
        // after that does not. Without these two, the test stayed green if you removed the guard AND the
        // try/catch — exactly what it is meant to prove.
        assert.strictEqual(typeof w.beeflowIntegrations, 'object',
            'beeflowIntegrations staat NA de define-lus; is hij weg, dan heeft een worp de rest van de brug '
            + 'meegesleurd en krijgt paginacode daar een TypeError');
        assert.ok(w.document.querySelector(tag).textContent.includes(bf.getBfElement(tag).surfaces.reactShare.notice),
            'de veeg heeft het element alsnog gemarkeerd — ook al mocht de define niet doorgaan');
        assert.strictEqual(w.beeflowBf.state(tag), 'refused',
            'het vocabulaire weet nog steeds wat er van dit element geldt, ook al tekent de pagina hem zelf');
    } finally { dom.window.close(); }
});

test('de veeg staat er OOK voor als customElements ontbreekt', async () => {
    // The hook and the sweep completely overlapped in JSDOM: you could remove the sweep
    // and all tests stayed green. Here there is no hook — the only thing that
    // can still mark the element is the sweep.
    const tag = refusedTags()[0];
    const kill = '<script>try { delete window.customElements; } catch (e) {}<\/script>';
    const dom = await renderWithBridge(`<${tag}></${tag}>`, { headExtra: kill });
    try {
        const w = dom.window;
        assert.strictEqual(w.customElements, undefined, 'sanity: er is geen custom-element-hook meer');
        const el = w.document.querySelector(tag);
        assert.ok(el.textContent.includes(bf.getBfElement(tag).surfaces.reactShare.notice),
            'zonder hook is de veeg de enige uitweg; zonder veeg blijft dit element een leeg vak');
        assert.strictEqual(el.getAttribute('data-bf-state'), 'refused');
    } finally { dom.window.close(); }
});

test('een ONBEKEND element krijgt hier ook een melding, niet alleen aan de client-kant', async () => {
    // The bridge already knew it (`state('bf-nope')` is 'unknown'); it just didn't
    // draw it. An element from a newer server version, or a typo in
    // the tag name, therefore remained an empty box.
    const dom = await renderWithBridge('<bf-nope>Mijn eigen tekst</bf-nope>');
    try {
        const el = dom.window.document.querySelector('bf-nope');
        assert.strictEqual(el.getAttribute('data-bf-state'), 'unknown');
        assert.ok(el.textContent.includes('Mijn eigen tekst'), 'en zijn eigen tekst blijft staan');
        assert.ok(el.querySelector('[data-bf-notice]'), 'er staat een melding in');
    } finally { dom.window.close(); }
});

// ── 3. DE TWEELING: HET BRUGOPPERVLAK, HALF OM HALF ───────────────────

/**
 * The bridge surface of BOTH halves, with each difference named.
 *
 *   shared      names that exist on both sides. That they HAVE the same name does not
 *               mean they DO the same thing: `ask` exists on both sides,
 *               but here it refuses with a reason. That is the intent — a name
 *               that isn't there gives a TypeError; a name that refuses gives
 *               an explanation.
 *   missingHere names the client knows and this twin does NOT. Every entry is
 *               a gap that page code trips over, so every entry carries
 *               the damage. This list must not grow.
 *   serverOnly  names that exist only here, with the reason the client does not
 *               need them.
 *   proxy       the client enumerates names, and this side installs a Proxy that returns a no-op for
 *               EVERY name. A superset, so nothing here
 *               falls out of step.
 */
const BRIDGE_TWIN = {
    beeflowAI: { shared: ['chat', 'chatJSON', 'stream', 'ask'] },
    beeflowDB: {
        shared: ['query', 'exec', 'batch'],
        missingHere: {
            schema: 'een pagina die beeflowDB.schema() aanroept op een publieke share krijgt "is not a function". '
                + 'Een resolve-empty stub is hier NIET het antwoord: een leeg schema leest als "deze pagina heeft '
                + 'geen tabellen", en dat is dezelfde stilte die beeflowTables juist weigert. Dit vraagt een '
                + 'expliciete keuze (weigeren met reden), niet een reflex.',
        },
    },
    beeflowTables: { shared: ['query', 'insert', 'update'] },
    beeflowApp: { shared: ['call'] },
    beeflowAutomations: {
        shared: ['run', 'list'],
        missingHere: {
            getRun: 'run() is hier een no-op, dus er is geen draaiende automatisering om naar te vragen — maar een pagina '
                + 'die het tóch doet, krijgt "is not a function" in plaats van een uitleg.',
            getSteps: 'zelfde gat als getRun: een voortgangslijst opvragen loopt hier stuk op een TypeError.',
            cancel: 'zelfde gat als getRun: er valt niets af te breken, maar de pagina hoort dat te horen in '
                + 'plaats van halverwege om te vallen.',
        },
    },
    beeflowIntegrations: { proxy: true },
    beeflowBf: {
        shared: ['elements', 'lookup', 'state', 'reason', 'refresh'],
        serverExtra: {
            notice: 'de tekst die deze kant in het element zelf zet. Aan de client-kant tekent de renderer de '
                + 'melding uit het vocabulaire; hier is de brug de renderer, dus hier moet paginacode er ook '
                + 'bij kunnen.',
        },
        // The client side of this surface is written in a parallel W4 step and is still growing. That is why
        // there is a LOWER BOUND here instead of an equality: the QUESTIONS that both sides must be able to answer
        // are fixed; the list may become longer on that side. The contents of `elements` are deliberately
        // different on each side — each side carries
        // its own place from the same vocabulary.
        clientIsSuperset: true,
    },
};

/** Regeleindes gelijktrekken: de checkout kan CRLF dragen. */
function readSource(file) {
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    // No claim about behaviour: sanity guard against a path that silently yields an empty
    // string, after which clientBridgeText() below would be vacuously green
    // on a client half that was not read.
    assert.ok(raw.length > 500, `sanity: ${path.basename(file)} is gelezen en niet leeg`);
    return raw;
}

/**
 * The bridge text from a file that builds it as a template literal.
 *
 * The same trick as promptCatalogSync.test.js: not the exported value but the
 * SOURCE TEXT, because the bridge IS a literal. maskCode (W3 exports it
 * for this) strips the literals; we keep everything that contains a window.beeflow*
 * assignment.
 */
function clientBridgeText() {
    const parts = [];
    for (const file of CLIENT_BRIDGE_FILES) {
        assert.ok(fs.existsSync(file),
            `de client-helft van de tweeling staat niet (meer) op ${file}. Is hij verhuisd, zet het nieuwe pad `
            + 'dan in CLIENT_BRIDGE_FILES — anders vergelijkt deze test de helft die hij nog wél vindt en dekt '
            + 'hij precies de drift niet meer die hij moet vinden.');
        for (const literal of maskCode(readSource(file)).literals) {
            const value = String(literal.value || '');
            if (value.includes('window.beeflow')) parts.push(value);
        }
    }
    const text = parts.join('\n');
    assert.ok(text.length > 2000, 'sanity: de client-brug is uit de client-bestanden gesneden');
    return text;
}

/**
 * The names one level deep in `window.<global> = { … }`.
 *
 * Works on the MASKED text, so braces in strings and comments do not count —
 * otherwise a `"{"` in an error message would throw the brace count out of
 * step and the test would invent names.
 *
 * @returns {string[]|null} `null` if this global is not there as an object literal
 */
function bridgeMembers(text, global) {
    const { masked } = maskCode(text);
    const marker = `window.${global} = {`;
    const start = masked.indexOf(marker);
    if (start === -1) return null;
    let depth = 0;
    let end = -1;
    for (let i = start + marker.length - 1; i < masked.length; i++) {
        const c = masked[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    const body = masked.slice(start + marker.length, end);
    const names = [];
    let depthInBody = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '{' || c === '(' || c === '[') { depthInBody++; continue; }
        if (c === '}' || c === ')' || c === ']') { depthInBody--; continue; }
        if (depthInBody !== 0) continue;
        const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
        if (m) { names.push(m[1]); i += m[0].length - 1; }
    }
    return names;
}

test('drift — de tweeling draagt precies het brugoppervlak dat de tabel beschrijft', () => {
    const client = clientBridgeText();
    const server = bridge();

    for (const [global, spec] of Object.entries(BRIDGE_TWIN)) {
        const shared = spec.shared || [];
        const missing = Object.keys(spec.missingHere || {});
        const serverExtra = Object.keys(spec.serverExtra || {});

        if (spec.proxy) {
            // No object literal to compare: the Proxy catches every name.
            // That really has to be a Proxy, then.
            assert.match(server, new RegExp(`window\\.${global} = new Proxy\\(`),
                `${global} hoort hier een Proxy te zijn — een objectletterlijk zou namen missen die de client wél kent`);
            assert.ok((bridgeMembers(client, global) || []).length > 0,
                `sanity: de client somt namen op onder ${global}`);
            continue;
        }

        const here = bridgeMembers(server, global);
        assert.ok(Array.isArray(here) && here.length > 0,
            `sanity: ${global} is in de uitgezonden brug gevonden`);
        const there = bridgeMembers(client, global);
        assert.ok(Array.isArray(there) && there.length > 0,
            `sanity: ${global} is in de client-brug gevonden`);

        // Direction 1 — this twin carries exactly the shared names (plus what
        // belongs here only, with a reason).
        assert.deepStrictEqual([...here].sort(), [...shared, ...serverExtra].sort(),
            `services/publicBridgeScript.js draagt een ander ${global}-oppervlak dan de tabel hierboven zegt. `
            + 'Is er een naam bijgekomen? Zet hem er ook aan de client-kant in en noteer hem als gedeeld. Is er '
            + 'een naam weg? Dan loopt paginacode die hem aanroept vanaf nu op een TypeError.');
        for (const [name, why] of Object.entries(spec.serverExtra || {})) {
            assert.ok(typeof why === 'string' && why.length > 30,
                `${global}.${name} staat alleen aan deze kant zonder leesbare reden`);
        }

        // Richting 2 — de client draagt de gedeelde namen plus de benoemde gaten.
        if (spec.clientIsSuperset) {
            const lacking = shared.filter(name => !there.includes(name));
            assert.deepStrictEqual(lacking, [],
                `de client-helft van ${global} beantwoordt ${lacking.join(', ')} niet meer. Dit oppervlak bestaat `
                + 'juist opdat een pagina op BEIDE plekken met dezelfde vraag kan uitvinden wat er van een element '
                + 'terechtkomt; valt een vraag aan één kant weg, dan moet de pagina gaan raden.');
            continue;
        }
        assert.deepStrictEqual([...there].sort(), [...shared, ...missing].sort(),
            `de client-helft draagt een ander ${global}-oppervlak dan de tabel hierboven zegt. Een naam die daar `
            + 'bij komt en hier niet, is precies hoe het beeflowAI-oppervlak van reactBundleServer.js uit de pas is '
            + 'gaan lopen: pagina werkt in de preview, TypeError op de share.');
    }
});

test('de bekende gaten in de tweeling staan benoemd, met de schade erbij, en groeien niet', () => {
    // Pin, don't whitewash. These names exist on the client side and not
    // here; page code that calls them gets a TypeError on a public
    // share. They are here so they stay visible and none gets added.
    const gaps = [];
    for (const [global, spec] of Object.entries(BRIDGE_TWIN)) {
        for (const [name, damage] of Object.entries(spec.missingHere || {})) {
            assert.ok(typeof damage === 'string' && damage.length > 30,
                `${global}.${name} staat als gat genoteerd zonder te zeggen wat er misgaat`);
            gaps.push(`${global}.${name}`);
        }
    }
    assert.deepStrictEqual(
        gaps.sort(),
        ['beeflowAutomations.cancel', 'beeflowAutomations.getRun', 'beeflowAutomations.getSteps', 'beeflowDB.schema'],
        'de lijst met bekende gaten in de tweeling is veranderd. Groeit hij, dan is er een naam aan de client-kant '
        + 'bijgekomen zonder tegenhanger hier — dicht hem, of leg vast waarom hij hier niet hoort. Krimpt hij, dan '
        + 'is er een gat gedicht: haal hem dan ook uit BRIDGE_TWIN.missingHere.',
    );
});

// ── 4. DE DERDE BRUG: DE INGEBAKKEN STUB ──────────────────────────────

/**
 * The stub from services/reactBundleServer.js was pinned nowhere — and that is precisely
 * the bridge that ALWAYS runs: composeReactDoc bakes it into every react document,
 * the public share and the picture the builder AI of the page gets to see. The bridge above
 * is only injected when public AI is on, and that is default OFF.
 *
 * The `beeflowAI` surface of that file is the reason this whole
 * twin table exists: it carried complete/ground/generate and was missing
 * chat/chatJSON/stream/ask. Those three old names remain (page code may call them), but they are now
 * NAMED instead of a silent deviation.
 */
const STUB_LEGACY_AI = {
    complete: 'oudste stub-naam; alleen dit bestand heeft hem ooit gehad. Weghalen zou paginacode breken die '
        + 'hem in de headless render aanroept, dus hij blijft — maar benoemd, niet stil.',
    ground: 'zelfde verhaal als complete.',
    generate: 'zelfde verhaal als complete.',
};

test('de ingebakken stub draagt hetzelfde brugoppervlak als de tweeling', () => {
    for (const surface of bf.BRIDGE_SURFACES) {
        const stub = buildStubBridgeScript(surface);
        for (const [global, spec] of Object.entries(BRIDGE_TWIN)) {
            if (spec.proxy) {
                assert.match(stub, new RegExp(`window\\.${global} = new Proxy\\(`),
                    `${surface}: ${global} hoort ook in de stub een Proxy te zijn`);
                continue;
            }
            const here = bridgeMembers(stub, global);
            assert.ok(Array.isArray(here) && here.length > 0,
                `${surface}: ${global} staat niet in de ingebakken stub. Dat is de brug die ALTIJD draait; een `
                + 'naam die daar ontbreekt geeft een TypeError op elke react-share.');
            const expected = [
                ...(spec.shared || []),
                ...Object.keys(spec.serverExtra || {}),
                ...(global === 'beeflowAI' ? Object.keys(STUB_LEGACY_AI) : []),
            ];
            assert.deepStrictEqual([...here].sort(), [...expected].sort(),
                `${surface}: de ingebakken stub draagt een ander ${global}-oppervlak dan de tabel zegt. Dit is `
                + 'precies het bestand waar het beeflowAI-oppervlak jarenlang stil uit de pas is gelopen.');
        }
    }
});

test('de stub laat "leeg" en "gelukt" niet op hetzelfde uitkomen', () => {
    const stub = buildStubBridgeScript('reactShare');
    // A no-op that RESOLVES is the most dangerous of all: a self-built button
    // then reports success without anything having run. Both the table bridge
    // and the automation bridge must therefore REFUSE, with a reason.
    assert.match(stub, /beeflowTables is not available here/);
    assert.match(stub, /beeflowAutomations\.run is not available here/);
    assert.ok(!/run:noop/.test(stub),
        'run() mag geen stille no-op meer zijn — een pagina die hem aanroept hoort een reden te krijgen');
    // Ook in de brug hierboven, om precies dezelfde reden.
    assert.match(bridge(), /beeflowAutomations\.run is not available on shared links/);
});

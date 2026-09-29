/**
 * publicBridgeScript — de servertweeling voor react-mui publieke shares.
 *
 * ── WAAROM HIER EEN DRIFTTEST STAAT ─────────────────────────────────
 *
 * Dit bestand is een HANDBIJGEHOUDEN tweeling van de client-brug in
 * agent-hub/src/utils/composeWebpageDocument.js. Zijn buurman
 * services/reactBundleServer.js draagt al jaren dezelfde afspraak in
 * commentaar — "⚠️ KEEP IN SYNC met buildWebpagePreview.js … byte-identiek" —
 * en juist daar staat het bewijs dat een commentaarregel niets tegenhoudt:
 * `window.beeflowAI` heeft er de namen `complete`/`ground`/`generate`, die in
 * geen van de twee andere brugbestanden bestaan, en mist de vier namen die er
 * wél zijn. Een pagina die `beeflowAI.chat(...)` aanroept, krijgt daar een
 * TypeError.
 *
 * De tests hieronder maken die afspraak mechanisch, op twee niveaus:
 *
 *   1. het bf-ELEMENTVOCABULAIRE — de brug zendt uit wat
 *      core/webpages/bfElements.js zegt, VELD VOOR VELD. Niet een telling: een
 *      test die alleen kijkt hoevéél elementen er zijn, blijft groen als iemand
 *      een attribuut toevoegt en de projectie vergeet;
 *   2. het BRUGOPPERVLAK — welke `window.beeflow*`-namen elke helft draagt.
 *      Elk verschil staat in één tabel, met de reden erbij, en die tabel wordt
 *      uit BEIDE bronnen gecontroleerd.
 *
 * ── WAT DIT KAN BEWIJZEN ────────────────────────────────────────────
 *
 * Dat de uitgezonden brug dezelfde elementen, dezelfde attributen en dezelfde
 * oordelen draagt als de registry; dat elk geweigerd element in een echt
 * document ZICHTBAAR meldt wat er niet kan; en dat geen van beide helften van
 * de tweeling stilzwijgend een naam kan krijgen of verliezen.
 *
 * ── WAT DIT NIET KAN BEWIJZEN ───────────────────────────────────────
 *
 * Dat de twee helften zich hetzelfde GEDRAGEN. Dezelfde naam kan aan beide
 * kanten iets anders doen; deze tests vergelijken vormen en, waar het om de
 * weigering gaat, wat er in de DOM belandt. Ze zeggen niets over de route
 * erachter. En ze zeggen niets over een share waar publieke AI UIT staat: dan
 * wordt deze brug helemaal niet geïnjecteerd en draait alleen de ingebakken
 * stub van reactBundleServer.js (zie het rapport bij deze stap).
 *
 * Draaien: cd server && node --test --test-force-exit services/publicBridgeScript.test.js
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
 * De CLIENT-helft van de tweeling. Twee bestanden, want de client-brug is
 * gesplitst: de platformbruggen worden in de composer opgebouwd, het
 * elementvocabulaire in zijn eigen runtime. Beide moeten bestaan — verhuist er
 * een, dan hoort deze test rood te worden en niet stilletjes de helft te lezen.
 */
const CLIENT_UTILS = path.join(__dirname, '..', '..', 'agent-hub', 'src', 'utils');
const CLIENT_BRIDGE_FILES = [
    path.join(CLIENT_UTILS, 'composeWebpageDocument.js'),
    path.join(CLIENT_UTILS, 'bfElementsRuntime.js'),
];

/** De brug zoals hij echt wordt uitgezonden. Eén plek, zodat elke test hetzelfde toetst. */
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
    // "Geen rijen" en "hier kun je geen tabel lezen" mogen niet hetzelfde
    // lezen: een resolve-empty stub zou een publieke pagina een lege tabel
    // laten tonen alsof de tabel leeg wás.
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

// ── 1. HET VOCABULAIRE: DE VORM, NIET EEN TELLING ─────────────────────

/**
 * De vorm die de brug hoort uit te zenden — hier LOS afgeleid uit de registry.
 *
 * Met opzet niet `publicShareVocabulary()` aanroepen: dan zou de test die
 * functie met zichzelf vergelijken en overal groen op blijven. Dit is een
 * tweede, met de hand geschreven afleiding van dezelfde bron; wijkt de
 * uitzending ervan af, dan is er iets stuk tussen registry en brug.
 */
function expectedVocabulary() {
    const out = {};
    for (const def of bf.BF_ELEMENTS) {
        const share = def.surfaces.reactShare;
        out[def.tag] = {
            summary: def.summary,
            needsJs: def.needsJs,
            // `reads` staat alleen op elementen die er een hebben — de projectie
            // laat een veld dat het element niet draagt gewoon weg.
            ...(def.reads !== undefined ? { reads: def.reads } : {}),
            attributes: def.attributes.map((a) => {
                // Alleen de velden die een BROWSER iets zeggen. `means` noemt
                // interne poortpaden en blijft op de server.
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
 * Het document zoals een publieke react-share het krijgt: de brug in `<head>`,
 * daarna de opmaak. Wacht op DOMContentLoaded, want de veeg over wat er al in
 * het document stond hangt daaraan.
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
    // Dit is het slot waardoor een nieuw ATTRIBUUT niet stil kan achterblijven.
    // Een test die alleen elementen telt, ziet zo'n toevoeging niet; deze legt
    // elke sleutel die in de registry voorkomt naast de projectietabel.
    const used = { element: new Set(), surface: new Set(), attribute: new Set() };
    for (const def of bf.BF_ELEMENTS) {
        for (const key of Object.keys(def)) used.element.add(key);
        for (const key of Object.keys(def.surfaces.reactShare)) used.surface.add(key);
        for (const attr of def.attributes) for (const key of Object.keys(attr)) used.attribute.add(key);
    }
    // Zonder deze regel zou een kapotte walk een groene test opleveren die
    // niets heeft gelezen.
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

        // Richting 2 — alles wat de tabel noemt, bestaat ook. Een verschrijving
        // in `ship` zou anders een veld stilzwijgend thuislaten.
        const phantom = [...decided].filter(k => !used[level].has(k));
        assert.deepStrictEqual(phantom, [],
            `PUBLIC_SHARE_PROJECTION.${level} noemt ${phantom.join(', ')}, en dat veld bestaat nergens in het `
            + 'vocabulaire — waarschijnlijk een verschrijving, en dan blijft het echte veld thuis.');

        // Een veld kan niet tegelijk verzonden worden en thuisblijven; zou dat
        // wel kunnen, dan zegt de tabel niets meer.
        const both = ship.filter(k => Object.prototype.hasOwnProperty.call(hold, k));
        assert.deepStrictEqual(both, [], `${level}: ${both.join(', ')} staat in ship én in hold`);

        // Een reden om iets thuis te laten is niet optioneel: "waarom niet" is
        // precies wat een volgende lezer moet kunnen nalopen.
        for (const [key, why] of Object.entries(hold)) {
            assert.ok(typeof why === 'string' && why.length > 20,
                `${level}.${key} blijft op de server zonder leesbare reden`);
        }
    }
});

test('drift — wat de projectie thuislaat, staat ook echt niet in de uitzending', async () => {
    // De tabel naast de UITVOER, niet naast zichzelf. Deze test vond een echt
    // gat: `attributes` werd apart meegegeven, buiten de shiplijst om, dus de
    // tabel kon zeggen "blijft thuis" terwijl het veld gewoon meereisde.
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
    // Het mechanisme zelf, met een verzonnen element: de echte registry is
    // bevroren, dus die kan de test niet muteren. Dit is het require-tijd-slot
    // dat maakt dat "vergeten" geen optie is.
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
 * De elementen die het op déze plek niet zelf doen — uit de registry.
 *
 * NIET `=== 'refused'`. Een element dat legitiem naar `inert` verschuift zou
 * dan geruisloos uit elke DOM-test in dit bestand vallen, en op de share weer
 * een leeg vak worden zonder dat één test protesteert. De brug markeert alles
 * wat hier niet `live` is en niet al door de snapshot-writer is vervangen
 * (`static`); deze helper stelt dezelfde vraag.
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
    // Ondergrens ("er zijn er minstens drie") liet een element ongemerkt uit de
    // verzameling stappen. Exacte gelijkheid dus, in beide richtingen.
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
            // createElement + appendChild, want zo komt een element op een
            // react-share in het document terecht: React bouwt de DOM zelf.
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
    // Negatieve controle. Zonder deze test zou de test hierboven groen kunnen
    // blijven op iets wat de brug helemaal niet doet.
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
    // In het document geschreven vóór de brug klaar was: de custom-element-hook
    // vuurt daar niet overal voor, dus er moet ook geveegd worden.
    const dom = await renderWithBridge(`<${tag} source="tbl_1"></${tag}>`);
    try {
        const { document } = dom.window;
        const el = document.querySelector(tag);
        assert.ok(el, 'sanity: het element staat in het document');
        assert.ok(el.textContent.includes(notice), 'ook een element uit de opmaak zelf meldt zijn weigering');
        assert.strictEqual(document.querySelectorAll('[data-bf-notice]').length, 1);

        // Opnieuw invoegen laat de hook nog een keer vuren; twee meldingen in
        // één element zou pas echt verwarrend zijn.
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
        // "Het werkte niet" is geen mededeling. Er moet staan dát het hier niet
        // kan; anders is de melding net zo nietszeggend als een leeg vak.
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
        // Een LOSGEKOPPELDE tak: hier vuurt connectedCallback nooit, want er
        // wordt niets aan het document gehangen. Dit is de uitweg voor code die
        // haar opmaak eerst opbouwt en pas later invoegt.
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
    // Een tweede customElements.define op dezelfde naam GOOIT. Zou de brug dat
    // niet opvangen, dan sleept één zelfgebouwd element de hele brug mee — geen
    // beeflowAI, geen beeflowTables, niets.
    const own = `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement {});<\/script>`;
    const dom = await renderWithBridge(`<${tag}></${tag}>`, { headExtra: own });
    try {
        const w = dom.window;
        assert.ok(w.beeflowBf, 'de brug is heel gebleven, ondanks de bezette naam');
        assert.strictEqual(typeof w.beeflowAI.chat, 'function', 'en het AI-oppervlak staat er nog');
        // DE TWEE ASSERTS DIE DE WORP ZOUDEN VOELEN. beeflowBf en beeflowAI
        // staan VÓÓR de define-lus en overleven een uitzondering sowieso; alles
        // erná niet. Zonder deze twee bleef de test groen als je de guard én de
        // try/catch weghaalde — precies wat hij hoort te bewijzen.
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
    // De hook en de veeg dekten elkaar in JSDOM volledig af: je kon de veeg
    // weghalen en alle tests bleven groen. Hier is er geen hook — het enige dat
    // het element dan nog kan markeren, is de veeg.
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
    // De brug wist het al (`state('bf-nope')` is 'unknown'); hij tekende het
    // alleen niet. Een element van een nieuwere serverversie, of een tikfout in
    // de tagnaam, bleef daardoor een leeg vak.
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
 * Het brugoppervlak van BEIDE helften, met elk verschil benoemd.
 *
 *   shared      namen die op allebei staan. Dat ze hier hetzelfde HETEN wil niet
 *               zeggen dat ze hetzelfde DOEN: `ask` bestaat aan beide kanten,
 *               maar weigert hier met een reden. Dat is de bedoeling — een naam
 *               die er niet is, geeft een TypeError; een naam die weigert, geeft
 *               een uitleg.
 *   missingHere namen die de client kent en deze tweeling NIET. Elke ingang is
 *               een gat waar paginacode op stukloopt, dus elke ingang draagt de
 *               schade. Deze lijst mag niet groeien.
 *   serverOnly  namen die alleen hier bestaan, met de reden waarom de client ze
 *               niet nodig heeft.
 *   proxy       de client somt namen op, deze kant zet er een Proxy neer die op
 *               ELKE naam een no-op teruggeeft. Een superset, dus hier valt
 *               niets uit de pas te lopen.
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
            getRun: 'run() is hier een no-op, dus er is geen draaiende routine om naar te vragen — maar een pagina '
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
        // De client-kant van dit oppervlak wordt in een parallelle W4-stap
        // geschreven en groeit nog. Daarom hier een ONDERGRENS in plaats van
        // een gelijkheid: de VRAGEN die beide kanten moeten kunnen beantwoorden
        // liggen vast, de lijst mag aan die kant langer worden. De inhoud van
        // `elements` is aan beide kanten met opzet anders — elke kant draagt
        // zijn eigen plek uit hetzelfde vocabulaire.
        clientIsSuperset: true,
    },
};

/** Regeleindes gelijktrekken: de checkout kan CRLF dragen. */
function readSource(file) {
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    // Geen claim over gedrag: sanity-guard tegen een pad dat stil een lege
    // string oplevert, waarna clientBridgeText() hieronder vacuous groen zou
    // zijn op een client-helft die niet is gelezen.
    assert.ok(raw.length > 500, `sanity: ${path.basename(file)} is gelezen en niet leeg`);
    return raw;
}

/**
 * De brugtekst uit een bestand dat hem als template-literal opbouwt.
 *
 * Dezelfde truc als promptCatalogSync.test.js: niet de geëxporteerde waarde
 * maar de BRONTEKST, want de brug ÍS een literal. maskCode (W3 exporteert hem
 * hiervoor) haalt de literals eruit; we houden alles wat een window.beeflow*-
 * toewijzing bevat.
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
 * De namen op één niveau diep van `window.<global> = { … }`.
 *
 * Werkt op de GEMASKEERDE tekst, zodat accolades in strings en commentaar niet
 * meetellen — zonder dat zou een `"{"` in een foutmelding de haakjestelling uit
 * de pas laten lopen en zou de test namen verzinnen.
 *
 * @returns {string[]|null} `null` als deze global er niet als objectletterlijk staat
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
            // Geen objectletterlijk om te vergelijken: de Proxy vangt elke naam
            // op. Dat moet dan wel echt een Proxy zijn.
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

        // Richting 1 — deze tweeling draagt precies de gedeelde namen (plus wat
        // met reden alleen hier hoort te staan).
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
    // Pinnen, niet goedpraten. Deze namen bestaan aan de client-kant en niet
    // hier; paginacode die ze aanroept krijgt een TypeError op een publieke
    // share. Ze staan hier zodat ze zichtbaar blijven en er geen bij komt.
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
 * De stub uit services/reactBundleServer.js stond nergens gepind — en juist die
 * is de brug die ALTIJD draait: composeReactDoc bakt hem in elk react-document,
 * de publieke share én het plaatje dat de bouwer-AI van de pagina te zien
 * krijgt. De brug hierboven wordt alleen geïnjecteerd als publieke AI aan staat,
 * en dat staat default UIT.
 *
 * Het `beeflowAI`-oppervlak van dat bestand is de reden dat deze hele
 * tweelingtabel bestaat: het droeg complete/ground/generate en miste
 * chat/chatJSON/stream/ask. Die drie oude namen blijven staan (paginacode kan ze
 * aanroepen), maar ze staan nu BENOEMD in plaats van als stille afwijking.
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
    // Een no-op die RESOLVET is het gevaarlijkst van allemaal: een zelfgebouwde
    // knop meldt dan succes zonder dat er iets is gedraaid. Zowel de tabelbrug
    // als de routine-brug moet daarom WEIGEREN, met een reden.
    assert.match(stub, /beeflowTables is not available here/);
    assert.match(stub, /beeflowAutomations\.run is not available here/);
    assert.ok(!/run:noop/.test(stub),
        'run() mag geen stille no-op meer zijn — een pagina die hem aanroept hoort een reden te krijgen');
    // Ook in de brug hierboven, om precies dezelfde reden.
    assert.match(bridge(), /beeflowAutomations\.run is not available on shared links/);
});

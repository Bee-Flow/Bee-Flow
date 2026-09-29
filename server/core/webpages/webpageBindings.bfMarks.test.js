/**
 * core/webpages/webpageBindings — de ELEMENTSCAN: waar staat een `bf-*`?
 *
 * Dit is de bron van de markeringen in de Code-tab. Wat hier vastligt is niet
 * "de scan is slim", maar wat hij mag BEWEREN:
 *
 *   - een element wordt gevonden op de regel waar de auteur het schreef, in
 *     ELK tekstbestand van de pagina — ook in `src/App.jsx`, waar een
 *     react-mui-project zijn hele app heeft staan;
 *   - een onbekend `bf-*`-element komt er HERKENBAAR onbekend uit, nooit als
 *     een gewoon element zonder koppeling;
 *   - onleesbare bestanden geven `scanned:false`, en dat mag niet te
 *     onderscheiden zijn van "deze pagina heeft geen koppelingen" — precies
 *     het verschil dat de legenda in de Code-tab moet tonen;
 *   - dit bestand schrijft zelf geen tagnaam en geen eigen tagpatroon op: de
 *     namen én het patroon komen uit core/webpages/bfElements.js.
 *
 * Draaien: cd server && node --test --test-force-exit core/webpages/webpageBindings.bfMarks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const bf = require('./bfElements');
const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const storageStore = require('../../stores/storageStore');
const webpageStore = require('../../stores/webpageStore');
const bindings = require('./webpageBindings');

const OWNER = 'u-owner';

/**
 * De tags die deze test gebruikt komen UIT de registry, niet uit het
 * toetsenbord: zo blijft de test geldig als het vocabulaire verandert, en zo
 * legt hij bovendien vast dát er zulke elementen zijn.
 */
const TABLE = bf.BF_ELEMENTS.find(e => e.binding && e.binding.kind === 'datatable');
const AUTOMATION = bf.BF_ELEMENTS.find(e => e.binding && e.binding.kind === 'automation');
const AGENT = bf.BF_ELEMENTS.find(e => e.binding && e.binding.kind === 'agent');

assert.ok(TABLE && AUTOMATION && AGENT,
    'sanity: het vocabulaire kent een tabel-, een routine- en een agent-element');

/** `<bf-x a="1" b="2">` uit een definitie, zodat er geen tagnaam in deze test staat. */
function open(def, attrs = {}) {
    const written = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${def.tag}${written}>`;
}

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return Promise.resolve().then(fn).finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

function stubs({ available = true, slots = {}, extras = [], slotsThrow = false } = {}) {
    return [
        [storageStore, 'isAvailable', () => available],
        [webpageStore, 'readAllSlots', async () => { if (slotsThrow) throw new Error('rustfs down'); return slots; }],
        [webpageStore, 'listExtraFiles', async () => extras.map(e => ({
            path: e.path, isText: e.isText !== false, mimeType: 'text/jsx',
        }))],
        [webpageStore, 'readExtraFile', async ({ path: p }) => ({ text: extras.find(e => e.path === p)?.text ?? '' })],
        [bridgeGrants, 'getBridgeGrants', async () => ({ ai: {}, automations: [], integrations: [], tables: [], agent: null })],
    ];
}

// ── waar staat het, en waar hangt het aan? ────────────────────────────

test('een element wordt gevonden op zijn eigen regel, met het slot erbij', () => {
    const html = [
        '<h1>Prices</h1>',
        '<p>intro</p>',
        `${open(TABLE, { [TABLE.binding.from]: 'tbl_1' })}</${TABLE.tag}>`,
    ].join('\n');

    const out = bindings.scanBfElements({ html });

    assert.strictEqual(out.counts.total, 1, 'een sluittag telt niet als tweede element');
    assert.strictEqual(out.marks.length, 1);
    const [mark] = out.marks;
    assert.strictEqual(mark.line, 3);
    assert.strictEqual(mark.source, 'index.html');
    // Het SLOT is wat de editor als sleutel gebruikt; op de bestandsnaam
    // matchen zou de client een tweede naamlijst geven.
    assert.strictEqual(mark.slot, 'html');
    assert.strictEqual(mark.tag, TABLE.tag);
    assert.strictEqual(mark.known, true);
    assert.strictEqual(mark.family, 'datatable');
    assert.strictEqual(mark.targetId, 'tbl_1');
    assert.deepStrictEqual(mark.missing, []);
});

test('de familie komt uit de binding, niet uit de naam — drie soorten naast elkaar', () => {
    const html = [
        open(TABLE, { [TABLE.binding.from]: 'tbl_1' }),
        open(AUTOMATION, { [AUTOMATION.binding.from]: 'auto_1' }),
        open(AGENT, { [AGENT.binding.from]: 'ag_1' }),
    ].join('\n');

    const out = bindings.scanBfElements({ html });

    assert.deepStrictEqual(out.marks.map(m => m.family), ['datatable', 'automation', 'agent']);
    assert.deepStrictEqual(out.marks.map(m => m.line), [1, 2, 3]);
    assert.deepStrictEqual(out.marks.map(m => m.targetId), ['tbl_1', 'auto_1', 'ag_1']);
});

test('een alias-attribuut landt op dezelfde binding als de canonieke naam', () => {
    const alias = (TABLE.attributes.find(a => a.name === TABLE.binding.from).aliases || [])[0];
    assert.ok(alias, 'sanity: het tabelelement heeft een alias voor zijn bronattribuut');

    const out = bindings.scanBfElements({ html: open(TABLE, { [alias]: 'tbl_9' }) });
    assert.strictEqual(out.marks[0].targetId, 'tbl_9',
        'wie de alias schrijft, hoort dezelfde markering te krijgen als wie de canonieke naam schrijft');
});

test('een element zonder zijn verplichte attribuut is GEMARKEERD maar zonder doel', () => {
    // Dit is het geval waar de auteur iets aan moet doen: het element staat er,
    // maar het hangt nergens aan. Het blijft wél een tabelelement — de familie
    // komt uit de definitie — dus wat het onderscheid draagt is `missing` en
    // een leeg `targetId`, en dáár leest de Code-tab op.
    const out = bindings.scanBfElements({ html: `${open(TABLE)}</${TABLE.tag}>` });

    assert.strictEqual(out.marks.length, 1);
    assert.strictEqual(out.marks[0].known, true);
    assert.strictEqual(out.marks[0].family, TABLE.binding.kind);
    assert.strictEqual(out.marks[0].targetId, null, 'er staat geen adres, dus er mag er ook geen uit komen');
    assert.deepStrictEqual(out.marks[0].missing, [TABLE.binding.from]);
    assert.strictEqual(out.counts.known, 1);
});

test('het agent-element valt terug op de agent van de PAGINA', () => {
    const out = bindings.scanBfElements({ html: `${open(AGENT)}</${AGENT.tag}>` });
    const mark = out.marks[0];
    assert.strictEqual(mark.family, 'agent', 'zonder eigen id hangt het blok aan de agent van de pagina');
    assert.strictEqual(mark.targetId, null);
    assert.strictEqual(mark.fallback, AGENT.binding.fallback);
});

// ── BIJT: onbekend is niet hetzelfde als leeg ─────────────────────────

test('BIJT — een onbekend bf-element komt er herkenbaar onbekend uit', () => {
    const out = bindings.scanBfElements({ html: '<bf-widget action="a1">Klik</bf-widget>' });

    assert.strictEqual(out.marks.length, 1, 'iets onbekends verzwijgen is precies wat DOMPurify al doet');
    const mark = out.marks[0];
    assert.strictEqual(mark.known, false);
    assert.strictEqual(mark.reason, 'unknown-bf-element');
    assert.strictEqual(mark.family, null);
    assert.strictEqual(mark.missing, null,
        '"er ontbreekt niets" is een uitspraak die je over een onbekend element niet kunt doen');
    assert.deepStrictEqual(out.unknownTags, ['bf-widget']);
    assert.deepStrictEqual(out.counts, { total: 1, known: 0, unknown: 1 });
});

test('een gewone tag met bf in de naam wordt niet aangezien voor een element', () => {
    // `class="bf-table-colhead"` bestaat echt in de frontend; een klassenaam is
    // geen element, en een vals alarm zou de markering waardeloos maken.
    const out = bindings.scanBfElements({
        html: '<div class="bf-table-colhead">x</div>\n<beefy-table></beefy-table>',
    });
    assert.deepStrictEqual(out.marks, []);
    assert.strictEqual(out.counts.total, 0);
});

// ── alle bestanden, niet de drie slots ────────────────────────────────

test('BIJT — een react-mui-pagina heeft haar elementen in src/, en die moeten worden gevonden', async () => {
    const extras = [
        { path: 'src/App.jsx', text: `export default function App(){\n  return (${open(TABLE, { [TABLE.binding.from]: 'tbl_1' })}</${TABLE.tag}>);\n}` },
    ];
    await withPatches(stubs({ slots: { html: '', css: '', js: '' }, extras }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.elements.scanned, true);
        assert.strictEqual(out.elements.marks.length, 1,
            'een element in src/App.jsx mag niet verdwijnen omdat het niet in een van de drie slots staat');
        assert.strictEqual(out.elements.marks[0].source, 'src/App.jsx',
            'de auteur moet weten WELK bestand hij moet openen');
        assert.strictEqual(out.elements.marks[0].slot, null, 'een extra bestand heeft geen slot');
        assert.strictEqual(out.elements.marks[0].line, 2);
    });
});

test('BIJT — ook het css-slot wordt gelezen, anders is een gemist bestand niet te zien', async () => {
    // `style.css` doet niet mee in de oproepscan. Voor de elementscan moet elk
    // tekstbestand dat de editor toont zijn gelezen: een slot dat overgeslagen
    // wordt levert nul markeringen op, en dat leest als "hier staat niets".
    // LET OP: geen COMMENTAAR als voorbeeld meer. Sinds de sluitronde maskeert
    // de scan commentaar weg — uitgecommentarieerde code is geen koppeling — dus
    // een `/* … */`-fixture zou nul markeringen opleveren en daarmee niet meer
    // bewijzen dat het slot überhaupt wordt gelezen. Dit is een echte, levende
    // regel: een generated-content-regel die de tag als tekst neerzet.
    const slots = {
        html: '<p>hi</p>',
        css: `.x::before{content:"${open(TABLE, { [TABLE.binding.from]: 'tbl_1' })}"}`,
        js: `el.innerHTML = '${open(AUTOMATION, { [AUTOMATION.binding.from]: 'auto_1' })}';`,
    };
    await withPatches(stubs({ slots }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.deepStrictEqual(
            out.elements.marks.map(m => m.slot).sort(),
            ['css', 'js'],
            'een element in style.css of script.js hoort gevonden te worden waar de auteur het schreef',
        );
    });
});

test('een aanhalingsteken in een attribuutwaarde kapt de tag niet af', () => {
    const html = `<div title="a > b">x</div>${open(TABLE, { [TABLE.binding.from]: 'tbl_1', label: 'a > b' })}`;
    const out = bindings.scanBfElements({ html });
    assert.strictEqual(out.marks.length, 1);
    assert.strictEqual(out.marks[0].targetId, 'tbl_1',
        'de attribuutlezer moet over een > IN een waarde heen kunnen');
});

// ── de drie standen ───────────────────────────────────────────────────

test('BIJT — onleesbare bestanden geven scanned:false, nooit een lege lijst', async () => {
    await withPatches(stubs({ available: false }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.elements.scanned, false);
        assert.deepStrictEqual(out.elements.marks, []);
    });
    await withPatches(stubs({ slotsThrow: true }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.elements.scanned, false,
            'een half gelezen project is geen grond voor "deze pagina heeft geen koppelingen"');
    });
});

test('een gelezen pagina zonder elementen is scanned:true met een lege lijst', async () => {
    await withPatches(stubs({ slots: { html: '<p>hi</p>', css: '', js: '' } }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.elements.scanned, true);
        assert.deepStrictEqual(out.elements.marks, []);
        assert.strictEqual(out.elements.counts.total, 0);
    });
});

test('meer elementen dan de bovengrens worden geteld, niet stil weggelaten', () => {
    const one = `${open(TABLE, { [TABLE.binding.from]: 'tbl_1' })}</${TABLE.tag}>`;
    const out = bindings.scanBfElements({ html: new Array(400).fill(one).join('\n') });

    assert.strictEqual(out.counts.total, 400);
    assert.ok(out.marks.length < 400, 'sanity: de bovengrens doet iets');
    assert.strictEqual(out.truncated, 400 - out.marks.length,
        'wat er niet bij kon moet te tellen zijn, anders lijkt de pagina kleiner dan hij is');
});

// ── geen tweede lijst, en geen tweede patroon ─────────────────────────

test('BIJT — webpageBindings kent geen tagnaam en schrijft geen eigen tagpatroon', () => {
    // Eigen naam (niet `src`) om een toevallige woordmatch met "src/App.jsx" in
    // de foutmeldingen van de test hierboven te vermijden — de source-text-
    // teller ziet anders twee ongerelateerde asserties als brontekst-checks.
    const bindingsSrc = fs.readFileSync(path.join(__dirname, 'webpageBindings.js'), 'utf8');

    // (1) Geen tagnaam in een stringliteral. Dezelfde toets die de drifttest
    //     over de hele serverbron doet, hier van dichtbij: dit bestand is de
    //     nieuwste consument en dus de eerstvolgende kandidaat om af te drijven.
    const tagWord = new RegExp(`(?<![-\\w])(?:${bf.BF_TAGS.join('|')})(?![-\\w])`, 'g');
    const strays = bindings.maskCode(bindingsSrc).literals
        .map(l => String(l.value || '').match(tagWord) || []).flat();
    assert.deepStrictEqual(strays, [],
        'webpageBindings.js schrijft een bf-tagnaam op in plaats van hem uit de registry te lezen');

    // (2) En geen eigen idee van hoe een element ERUITZIET. Twee patronen lopen
    //     net zo hard uit elkaar als twee lijsten; het patroon hoort in de
    //     registry, en hier hoort alleen de verwijzing ernaartoe te staan.
    //     Na het maskeren is commentaar weggehaald en is elke string een
    //     plaatshouder, dus wat er dan nog aan `bf-` overblijft staat in CODE —
    //     en omdat een identifier geen koppelteken kan dragen, kan dat alleen
    //     een eigen regex-literal zijn.
    assert.ok(bindingsSrc.includes('bfElements.BF_TAG_SCAN'),
        'de scan hoort het patroon uit de registry te halen');
    const inCode = bindings.maskCode(bindingsSrc).masked.match(/bf-/gi) || [];
    assert.deepStrictEqual(inCode, [],
        'webpageBindings.js draagt een eigen patroon met `bf-` erin — dat is een tweede lezing van hetzelfde '
        + 'vocabulaire, en die kan achterlopen op core/webpages/bfElements.js');
});

test('uitgecommentarieerde code is geen koppeling', async () => {
    // De auteur zag een gemarkeerde regel met een adres erachter op code die UIT
    // staat, en de usage-index beweerde dat de pagina die tabel gebruikt. Per
    // taal een eigen commentaarvorm, want de maskeerder moet weten waar hij naar
    // kijkt; regelnummers van wat er WEL staat blijven kloppen.
    const live = open(TABLE, { [TABLE.binding.from]: 'tbl_live' });
    const dead = open(TABLE, { [TABLE.binding.from]: 'tbl_dead' });
    const slots = {
        html: `<!-- oude versie:\n  ${dead}\n-->\n${live}`,
        css: `/* ${dead} */`,
        js: `// ${dead}`,
    };
    await withPatches(stubs({ slots }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.deepStrictEqual(
            out.elements.marks.map(m => `${m.slot}:${m.targetId}@${m.line}`),
            ['html:tbl_live@4'],
            'alleen de LEVENDE regel telt, en zijn regelnummer schuift niet op',
        );
        assert.deepStrictEqual(
            (out.uses.targets.datatable || []).map(t => t.id),
            ['tbl_live'],
            'en de usage-index beweert niet dat de pagina de uitgecommentarieerde tabel gebruikt',
        );
    });
});

test('een adres in een STRING blijft wel meetellen', async () => {
    // De scherpe rand van de maskeerder: `//` in "https://…" mag de rest van de
    // regel niet wegpoetsen, en een element dat de pagina via innerHTML neerzet
    // is een echte koppeling.
    const slots = {
        html: '',
        css: '',
        js: `const u = "https://x.test/a"; el.innerHTML = '${open(AUTOMATION, { [AUTOMATION.binding.from]: 'auto_9' })}';`,
    };
    await withPatches(stubs({ slots }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.deepStrictEqual(out.elements.marks.map(m => m.targetId), ['auto_9']);
    });
});

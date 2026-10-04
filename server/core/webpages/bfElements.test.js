/**
 * core/webpages/bfElements — het vocabulaire zelf.
 *
 * Wat hier getoetst wordt is de DATASTRUCTUUR, niet een renderer: dat elk
 * element bestaat, dat elk verplicht attribuut als verplicht bekendstaat, dat
 * een element dat JS nodig heeft nergens als "statisch uitgeklapt" kan worden
 * opgeschreven, en dat een ONBEKEND `bf-*`-element herkenbaar onbekend
 * terugkomt in plaats van stil door te glippen.
 *
 * Draaien: cd server && node --test --test-force-exit core/webpages/bfElements.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const bf = require('./bfElements');

/**
 * Het vocabulaire, hier LETTERLIJK opgeschreven.
 *
 * Met opzet geen `bf.BF_TAGS`: dan zou de test met elke wijziging meebewegen en
 * niets meer beweren. Deze lijst hoort mee te veranderen als iemand het
 * vocabulaire verandert — dat is precies het moment waarop een mens moet kijken.
 */
const VOCABULARY = ['bf-table', 'bf-stat', 'bf-button', 'bf-form', 'bf-agent'];

/** Welke attributen zijn per element verplicht — ook letterlijk, om dezelfde reden. */
const REQUIRED = {
    'bf-table': ['source'],
    'bf-stat': ['source'],
    'bf-button': ['run'],
    'bf-form': ['automation'],
    // Zonder attribuut valt bf-agent terug op de agent van de pagina; er is dus
    // niets dat de auteur MOET schrijven.
    'bf-agent': [],
};

/** Welke elementen JS nodig hebben — en dus in de vanilla snapshot dood zijn. */
const NEEDS_JS = ['bf-button', 'bf-form', 'bf-agent'];

test('het vocabulaire is precies deze vijf elementen', () => {
    assert.deepStrictEqual([...bf.BF_TAGS], VOCABULARY);
});

test('elk element is volledig beschreven: samenvatting, attributen, binding, drie plekken', () => {
    for (const tag of VOCABULARY) {
        const def = bf.getBfElement(tag);
        assert.ok(def, `${tag} bestaat`);
        assert.ok(typeof def.summary === 'string' && def.summary.length > 20,
            `${tag} draagt een leesbare samenvatting — die belandt straks in de bouwer-prompt`);
        assert.strictEqual(typeof def.needsJs, 'boolean', `${tag} zegt of hij JS nodig heeft`);
        assert.ok(def.attributes.length > 0, `${tag} kent minstens één attribuut`);
        for (const attr of def.attributes) {
            assert.ok(typeof attr.name === 'string' && attr.name, `${tag} attribuut heeft een naam`);
            assert.ok(typeof attr.means === 'string' && attr.means.length > 10,
                `${tag}/${attr.name} legt uit wat hij betekent — een attribuut zonder uitleg kan niemand gebruiken`);
        }
        for (const surface of bf.SURFACES) {
            const entry = def.surfaces[surface];
            assert.ok(entry, `${tag} zegt wat er op ${surface} van hem overblijft`);
            assert.ok(bf.STATES.includes(entry.state), `${tag}/${surface} draagt een bekende toestand`);
            assert.ok(typeof entry.why === 'string' && entry.why.length > 20,
                `${tag}/${surface} legt uit WAAROM — anders is het oordeel niet na te lopen`);
        }
    }
});

test('BIJT — wat JS nodig heeft is in de vanilla snapshot inert, met een zichtbare melding', () => {
    // Dit is de regel die W4 bestaat om te beschermen. In de vanilla publieke
    // snapshot draait geen JS; een element dat JS nodig heeft kan daar dus per
    // definitie niet meer dan inert zijn. Zou iemand hem ooit op 'static' of
    // 'live' zetten, dan belooft het vocabulaire iets dat de pagina niet doet.
    for (const tag of VOCABULARY) {
        const def = bf.getBfElement(tag);
        const vanilla = def.surfaces.vanillaSnapshot;
        if (def.needsJs) {
            assert.strictEqual(vanilla.state, 'inert',
                `${tag} heeft JS nodig en kan in een script-vrije snapshot niets anders zijn dan inert`);
            assert.ok(typeof vanilla.notice === 'string' && vanilla.notice.length > 10,
                `${tag} moet een ZICHTBARE melding dragen — DOMPurify pakt een onbekend element stil uit, `
                + 'dus zonder tekst verdwijnt het spoorloos');
        } else {
            assert.strictEqual(vanilla.state, 'static',
                `${tag} heeft geen JS nodig en hoort server-side te worden uitgeklapt`);
        }
    }
    assert.deepStrictEqual(bf.tagsNeedingJs(), NEEDS_JS);
    assert.deepStrictEqual(bf.tagsExpandedServerSide(), ['bf-table', 'bf-stat']);
});

test('elk verplicht attribuut staat als verplicht opgeschreven, en ontbreken wordt gemeld', () => {
    for (const tag of VOCABULARY) {
        const def = bf.getBfElement(tag);
        const declared = def.attributes.filter(a => a.required === true).map(a => a.name);
        assert.deepStrictEqual(declared, REQUIRED[tag], `${tag}: verplichte attributen`);
        // En een leeg element meldt precies diezelfde namen als ontbrekend.
        assert.deepStrictEqual(bf.missingAttributes(tag, {}), REQUIRED[tag],
            `${tag}: een leeg element mist zijn verplichte attributen`);
        // Met alles ingevuld ontbreekt er niets meer.
        const filled = {};
        for (const name of REQUIRED[tag]) filled[name] = 'x';
        assert.deepStrictEqual(bf.missingAttributes(tag, filled), [], `${tag}: ingevuld ontbreekt er niets`);
    }
});

test('bf-stat: `column` is verplicht zodra de aggregatie iets anders is dan tellen', () => {
    assert.deepStrictEqual(bf.missingAttributes('bf-stat', { source: 't1' }), [],
        'tellen heeft geen kolom nodig');
    assert.deepStrictEqual(bf.missingAttributes('bf-stat', { source: 't1', agg: 'count' }), []);
    assert.deepStrictEqual(bf.missingAttributes('bf-stat', { source: 't1', agg: 'sum' }), ['column'],
        'een som zonder kolom is geen getal');
    assert.deepStrictEqual(bf.missingAttributes('bf-stat', { source: 't1', agg: 'sum', column: 'price' }), []);
    // De default staat in het vocabulaire, niet in de renderer.
    assert.strictEqual(bf.effectiveAttributes('bf-stat', { source: 't1' }).agg, 'count');
});

test('de oudere schrijfwijze `datatable` landt onder `source`', () => {
    assert.strictEqual(bf.canonicalAttribute('bf-table', 'datatable'), 'source');
    assert.deepStrictEqual(bf.readAttributes('bf-table', { datatable: ' tbl_1 ' }), { source: 'tbl_1' });
    // Canoniek wint als beide er staan — zelfde volgorde als de oude
    // `getAttribute('source') || getAttribute('datatable')`.
    assert.deepStrictEqual(bf.readAttributes('bf-table', { source: 'a', datatable: 'b' }), { source: 'a' });
    // Lege waarden bestaan niet: een leeg attribuut is een ontbrekend attribuut.
    assert.deepStrictEqual(bf.readAttributes('bf-table', { source: '   ' }), {});
});

test('de rijgrens is een eigenschap van het vocabulaire, niet van de renderer', () => {
    assert.strictEqual(bf.attributeSpec('bf-table', 'limit').max, bf.PUBLIC_ROWS_MAX);
    assert.strictEqual(bf.PUBLIC_ROWS_MAX, 100);
});

test('attributen lezen werkt zowel van een DOM-element als van een gewoon object', () => {
    const el = { getAttribute: (n) => (n === 'run' ? 'auto_9' : null) };
    assert.deepStrictEqual(bf.readAttributes('bf-button', el), { run: 'auto_9' });
    assert.deepStrictEqual(bf.readAttributes('bf-button', { run: 'auto_9' }), { run: 'auto_9' });
});

test('elke binding wijst een tabel, een automatisering of een agent aan — met zijn poort erbij', () => {
    const table = bf.bindingFor('bf-table', { source: 'tbl_1' });
    assert.deepStrictEqual(table, {
        kind: 'datatable', id: 'tbl_1', from: 'source',
        gate: 'bridge_grants.tables[].publicColumns', fallback: null,
    });
    assert.strictEqual(bf.bindingFor('bf-stat', { source: 'tbl_2' }).kind, 'datatable');
    assert.strictEqual(bf.bindingFor('bf-stat', { source: 'tbl_2' }).id, 'tbl_2');

    assert.strictEqual(bf.bindingFor('bf-button', { run: 'auto_1' }).kind, 'automation');
    assert.strictEqual(bf.bindingFor('bf-button', { run: 'auto_1' }).id, 'auto_1');
    assert.strictEqual(bf.bindingFor('bf-form', { automation: 'auto_2' }).kind, 'automation');
    assert.strictEqual(bf.bindingFor('bf-form', { automation: 'auto_2' }).id, 'auto_2');

    // Zonder id is er geen binding — behalve bij bf-agent, dat op de agent van
    // de PAGINA terugvalt. Dat is geen "geen binding": de usage-index moet die
    // pagina-agent tellen, anders lijkt een agent-blok nergens gebruikt.
    assert.strictEqual(bf.bindingFor('bf-table', {}), null);
    assert.strictEqual(bf.bindingFor('bf-button', {}), null);
    const agent = bf.bindingFor('bf-agent', {});
    assert.strictEqual(agent.kind, 'agent');
    assert.strictEqual(agent.id, null);
    assert.strictEqual(agent.fallback, 'bridge_grants.agent');
    assert.strictEqual(bf.bindingFor('bf-agent', { agent: 'ag_7' }).id, 'ag_7');
});

test('BIJT — een onbekend bf-element is HERKENBAAR onbekend, niet stil in orde', () => {
    // Het gevaar: DOMPurify pakt `<bf-widget action="x">Klik</bf-widget>` uit tot
    // `Klik` zonder één waarschuwing. Wie hier een lege definitie of een lege
    // lijst terugkrijgt, denkt dat er niets mis is.
    assert.strictEqual(bf.getBfElement('bf-widget'), null, 'geen lege definitie voor iets dat niet bestaat');
    assert.strictEqual(bf.isBfTag('bf-widget'), true, 'het ZIET er wel als een van ons uit');
    assert.strictEqual(bf.isKnownBfTag('bf-widget'), false);

    const seen = bf.inspectBfElement('bf-widget', { action: 'x' });
    assert.strictEqual(seen.known, false);
    assert.strictEqual(seen.isBf, true);
    assert.strictEqual(seen.reason, 'unknown-bf-element');
    assert.strictEqual(seen.binding, null, 'een onbekend element bindt niets');
    assert.strictEqual(seen.needsJs, null, '"weten we niet" is iets anders dan "nee"');
    // NIET [] — een lege lijst leest als "er ontbreekt niets", en dat is een
    // uitspraak die we over een onbekend element niet kunnen doen.
    assert.strictEqual(bf.missingAttributes('bf-widget', {}), null);
    assert.deepStrictEqual(bf.readAttributes('bf-widget', { action: 'x' }), {});

    // En een gewoon element is iets anders dan een onbekend bf-element.
    const div = bf.inspectBfElement('div');
    assert.strictEqual(div.isBf, false);
    assert.strictEqual(div.reason, 'not-a-bf-element');
});

test('een bekend element komt uit inspectBfElement met alles erop en eraan', () => {
    const seen = bf.inspectBfElement('BF-TABLE', { source: 'tbl_1', limit: '5' });
    assert.strictEqual(seen.known, true);
    assert.strictEqual(seen.tag, 'bf-table');
    assert.deepStrictEqual(seen.attrs, { source: 'tbl_1', limit: '5' });
    assert.deepStrictEqual(seen.missing, []);
    assert.strictEqual(seen.binding.id, 'tbl_1');
    assert.strictEqual(seen.needsJs, false);
    assert.strictEqual(seen.surfaces.vanillaSnapshot.state, 'static');
});

test('de scan haalt onbekende bf-elementen uit ruwe HTML, en laat gewone tags met rust', () => {
    const html = '<div><bf-table source="t"></bf-table><BF-Widget></BF-Widget>'
        + '<bf-table source="u"></bf-table><bf-button run="a"></bf-button><p>x</p></div>';
    const scan = bf.scanBfTags(html);
    assert.deepStrictEqual(scan.found, ['bf-table', 'bf-widget', 'bf-button'],
        'ontdubbeld, kleine letters, in volgorde van eerste voorkomen');
    assert.deepStrictEqual(scan.known, ['bf-table', 'bf-button']);
    assert.deepStrictEqual(scan.unknown, ['bf-widget']);

    assert.strictEqual(bf.hasBfTags('<p>niets</p>'), false);
    assert.strictEqual(bf.hasBfTags('<bf-table>'), true);
    assert.deepStrictEqual(bf.scanBfTags('<p>niets</p>').found, []);
    assert.deepStrictEqual(bf.scanBfTags(null).found, [], 'onleesbare invoer is geen uitzondering');
});

test('BIJT — assertCoversVocabulary gooit als een consument een element niet noemt', () => {
    // Dit is het slot dat het onmogelijk maakt een element toe te voegen zonder
    // dat de vanilla snapshot erop reageert: de module laadt dan niet meer.
    assert.strictEqual(bf.assertCoversVocabulary('een volledige consument', VOCABULARY), true);
    assert.strictEqual(bf.assertCoversVocabulary('idem, als map', Object.fromEntries(VOCABULARY.map(t => [t, 'x']))), true);

    assert.throws(
        () => bf.assertCoversVocabulary('een vergeetachtige consument', ['bf-table']),
        (err) => {
            assert.match(err.message, /een vergeetachtige consument/, 'de melding noemt WIE er tekortschiet');
            for (const tag of ['bf-stat', 'bf-button', 'bf-form', 'bf-agent']) {
                assert.ok(err.message.includes(tag), `de melding noemt ${tag}`);
            }
            return true;
        },
    );

    assert.throws(
        () => bf.assertCoversVocabulary('een verzinnende consument', [...VOCABULARY, 'bf-ghost']),
        /bf-ghost/,
        'een tag die het vocabulaire niet kent moet net zo hard vastlopen als een die ontbreekt',
    );
});

test('het publieke-share-vocabulaire is afgeleid en weigert met een reden', () => {
    const pub = bf.publicShareVocabulary();
    assert.deepStrictEqual(Object.keys(pub), VOCABULARY, 'elk element staat erin, zonder dat iemand het bijhoudt');
    for (const tag of VOCABULARY) {
        assert.strictEqual(pub[tag].state, 'refused',
            `${tag} wordt op een publieke share niet bediend`);
        // Een weigering MET reden — dezelfde regel als beeflowTables, dat op een
        // share weigert in plaats van een lege lijst terug te geven.
        assert.ok(typeof pub[tag].message === 'string' && pub[tag].message.includes(tag),
            `${tag} weigert met een reden waarin zijn eigen naam staat`);
    }
});

test('de prompt-regels zijn afgeleid, zodat er geen vierde lijst met de hand ontstaat', () => {
    const lines = bf.vocabularyPromptLines();
    assert.strictEqual(lines.length, VOCABULARY.length);
    for (const tag of VOCABULARY) {
        const line = lines.find(l => l.startsWith(`<${tag}>`));
        assert.ok(line, `${tag} krijgt een regel`);
        for (const name of REQUIRED[tag]) {
            assert.ok(line.includes(`${name} (required)`), `${tag}: ${name} staat als verplicht in de prompt`);
        }
    }
    // De inertie wordt BENOEMD in plaats van weggelaten: anders stelt het model
    // een knop voor en ontdekt de auteur pas na publiceren dat hij dood is.
    for (const tag of NEEDS_JS) {
        assert.match(lines.find(l => l.startsWith(`<${tag}>`)), /INERT once published/);
    }
});

test('de gegenereerde client-spiegel bevat exact het vocabulaire', () => {
    const mirror = bf.renderClientMirror();
    assert.ok(mirror.startsWith(bf.CLIENT_MIRROR_BEGIN), 'het blok begint bij de beginmarker');
    assert.ok(mirror.endsWith(bf.CLIENT_MIRROR_END), 'en eindigt bij de eindmarker');
    const json = mirror.slice(mirror.indexOf('export const BF_ELEMENTS = ') + 'export const BF_ELEMENTS = '.length,
        mirror.lastIndexOf(';'));
    const parsed = JSON.parse(json);
    assert.deepStrictEqual(parsed.map(e => e.tag), VOCABULARY);
    assert.deepStrictEqual(parsed, JSON.parse(JSON.stringify(bf.BF_ELEMENTS)),
        'de spiegel is de registry, niet een uittreksel ervan');
});

test('het vocabulaire is bevroren — niemand breidt het per ongeluk uit tijdens een run', () => {
    // Eén consument die per ongeluk in de lijst schrijft, zou de andere twee
    // stilzwijgend iets anders laten zien. Uitbreiden gooit; een toewijzing
    // gaat in deze (niet-strikte) module stil verloren, dus die toetsen we op
    // het resultaat.
    assert.throws(() => { bf.BF_ELEMENTS.push({ tag: 'bf-nope' }); });
    bf.BF_ELEMENTS[0].tag = 'bf-anders';
    bf.BF_ELEMENTS[0].attributes[0].required = false;
    assert.strictEqual(bf.BF_ELEMENTS[0].tag, 'bf-table');
    assert.strictEqual(bf.BF_ELEMENTS[0].attributes[0].required, true);
});

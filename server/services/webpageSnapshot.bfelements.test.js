/**
 * services/webpageSnapshot — wat er van het `bf-*`-vocabulaire in de VANILLA
 * publieke snapshot overblijft.
 *
 * De buurtest van webpageSnapshot.reactshare.test.js, die dezelfde writer van de
 * ANDERE kant bekijkt (welk slot krijgt de bytes). Hier gaat het om de bytes
 * zelf: wat ziet een anonieme bezoeker op /w/<slug>?
 *
 * ── WAT DEZE TEST BEWAAKT ───────────────────────────────────────────
 *
 * Twee regels, en ze wijzen tegengesteld:
 *
 *   1. `publicColumns` is DE poort en de ENIGE poort. `bf-stat` vat data samen,
 *      en een samenvatting van een kolom is nog steeds die kolom — dus de kolom
 *      waarover wordt gerekend moet zélf publiek zijn, en een tabel zonder
 *      publieke kolom levert ook geen `count` op.
 *   2. Wat in deze snapshot niet kan werken, moet dat ZELF zeggen. Er draait
 *      hier geen JS, dus `bf-button` / `bf-form` / `bf-agent` zijn dood — en
 *      "dood" mag, "stil" niet.
 *
 * Regel 2 is niet met een expander-uitvoer alleen te bewijzen: alles gaat daarna
 * nog door DOMPurify heen, en juist dáár verdwijnen dingen zonder waarschuwing
 * (`KEEP_CONTENT: true`, `ADD_TAGS` kent alleen `iframe`, en `form` staat in
 * FORBID_TAGS). Daarom draait elke uitvoer hieronder door de ECHTE
 * `webpageSnapshot.sanitizeHtml` voordat er iets over wordt beweerd. Een
 * meldingsblok dat de sanitizer niet overleeft, is precies zo stil als geen
 * meldingsblok.
 *
 * Draaien: cd server && node --test --test-force-exit services/webpageSnapshot.bfelements.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const bridgeGrants = require('../stores/webpage/bridgeGrants');
const dtAccess = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const bfElements = require('../core/webpages/bfElements');
const bfTable = require('./webpageBfTable');
const webpageSnapshot = require('./webpageSnapshot');

const OWNER = 'u-owner';

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return Promise.resolve().then(fn).finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

/** Vangt het log op; reden-codes horen daar te staan en nergens anders. */
async function withLog(fn) {
    const lines = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try { return { out: await fn(), lines }; }
    finally { console.warn = warn; console.error = error; }
}

const META = {
    key: 'orders',
    fields: [
        { id: 'f1', key: 'name', label: 'Product' },
        { id: 'f2', key: 'price', label: 'Price' },
        { id: 'f3', key: 'margin', label: 'Margin' },
    ],
};

const BINDING = {
    datatableId: 'tbl_1',
    mode: 'read',
    columns: ['name', 'price', 'margin'],
    publicColumns: ['name', 'price'],
};

const ROWS = [
    { id: 'r1', name: 'Basic', price: 10, margin: 3 },
    { id: 'r2', name: 'Plus', price: 15, margin: 9 },
];

function stubs({ tables = [BINDING], rows = ROWS, hasMore = false, onRead = null, throwOnRead = null } = {}) {
    return [
        [bridgeGrants, 'getBridgeGrants', async () => ({ ai: {}, automations: [], integrations: [], tables, agent: null })],
        [dtAccess, 'resolveDatatablePrincipalForUser', async (id) => ({ userId: id, orgId: 'org-1', organizationId: 'org-1', orgRole: null, groupIds: [] })],
        [datatableRuntime, 'resolveForPrincipal', async () => ({ meta: META, grade: 'viewer' })],
        [datatableRuntime, 'readRows', async (_r, opts) => {
            if (onRead) onRead(opts);
            if (throwOnRead) throw throwOnRead;
            return { rows, columns: opts.allowColumns, hasMore, count: rows.length, nextCursor: null };
        }],
    ];
}

/** Uitklappen én sanitizen — precies wat writeSnapshot met het html-slot doet. */
async function publish(html, patches = stubs()) {
    return withPatches(patches, async () => {
        const res = await withLog(() => bfTable.expandBfElements(html, { webpageId: 'wp1', ownerId: OWNER }));
        return { ...res, clean: webpageSnapshot.sanitizeHtml(res.out) };
    });
}

/** Geen enkel `bf-*`-element mag de snapshot in — uitgeklapt of niet. */
function assertNoBfElementsLeft(html) {
    assert.strictEqual(/<\s*bf-/i.test(html), false,
        'een bf-element dat de sanitizer haalt, wordt daar zwijgend uitgepakt; het hoort hiervoor al weg te zijn');
}

const STAT_DOC = (attrs) => `<html><body><bf-stat ${attrs}></bf-stat></body></html>`;

// ── bf-stat: het getal, en de poort eromheen ──────────────────────────

test('bf-stat counts the rows of a bound table and survives the sanitizer', async () => {
    const { clean } = await publish(STAT_DOC('source="tbl_1" label="Orders"'));
    assert.match(clean, /<div class="bf-stat">/);
    assert.match(clean, /<span class="bf-stat-value">2<\/span>/);
    assert.match(clean, /<span class="bf-stat-label">Orders<\/span>/);
    assertNoBfElementsLeft(clean);
});

test('bf-stat computes sum, avg, min and max over a public column', async () => {
    const cases = [['sum', '25'], ['avg', '12.5'], ['min', '10'], ['max', '15']];
    for (const [agg, expected] of cases) {
        const { clean } = await publish(STAT_DOC(`source="tbl_1" agg="${agg}" column="price"`));
        assert.match(clean, new RegExp(`<span class="bf-stat-value">${expected}</span>`),
            `agg="${agg}" hoort ${expected} op te leveren`);
    }
});

test('BITE — a sum over a column that is NOT public publishes nothing and never reads the table', async () => {
    // `margin` staat wél in de binding (`columns`) maar niet in `publicColumns`.
    // Een som over die kolom publiceert die kolom alsnog — samengevat, maar het
    // is dezelfde data — dus de poort moet hier dicht, en wel VOOR de lezing.
    let read = false;
    const res = await publish(
        STAT_DOC('source="tbl_1" agg="sum" column="margin"'),
        stubs({ onRead: () => { read = true; } }),
    );
    assert.strictEqual(read, false, 'er mag niet eens gelezen worden voor een niet-publieke kolom');
    assert.strictEqual(/12|9|3/.test(res.clean), false, 'geen enkel getal uit die kolom mag naar buiten');
    assert.match(res.clean, /<div class="bf-stat"><\/div>/, 'wel een leeg blok, niet het element zelf');
    assert.ok(res.lines.some(l => l.includes('column-not-public')), 'de reden hoort in het log');
    assert.strictEqual(/column-not-public/.test(res.clean), false, 'en nergens in de bytes');
});

test('BITE — an empty publicColumns publishes no count either, and reads nothing', async () => {
    // "Leeg betekent GEEN kolom" moet ook gelden voor een getal dat geen kolom
    // noemt: hoeveel rijen er zijn is een uitspraak over die tabel, en over een
    // tabel waarvan niets publiek is doen we geen uitspraken.
    let read = false;
    const res = await publish(
        STAT_DOC('source="tbl_1"'),
        stubs({ tables: [{ ...BINDING, publicColumns: [] }], onRead: () => { read = true; } }),
    );
    assert.strictEqual(read, false);
    assert.strictEqual(/bf-stat-value/.test(res.clean), false, 'geen getal zonder publieke kolom');
    assert.ok(res.lines.some(l => l.includes('no-public-columns')));
});

test('BITE — a stat over a table that does not fit in one read publishes nothing', async () => {
    // Een som over de eerste 500 van 5000 rijen is niet "ongeveer goed": hij is
    // fout, en aan het getal is dat niet te zien.
    const res = await publish(STAT_DOC('source="tbl_1" agg="sum" column="price"'), stubs({ hasMore: true }));
    assert.strictEqual(/bf-stat-value/.test(res.clean), false);
    assert.ok(res.lines.some(l => l.includes('too-many-rows')));
});

test('an unknown aggregation is not silently turned into a count', async () => {
    const res = await publish(STAT_DOC('source="tbl_1" agg="median" column="price"'));
    assert.strictEqual(/bf-stat-value/.test(res.clean), false);
    assert.ok(res.lines.some(l => l.includes('bad-agg')));
});

test('a stat without a source, and one without a column for a real aggregation, render nothing', async () => {
    const noSource = await publish(STAT_DOC('agg="count"'));
    assert.ok(noSource.lines.some(l => l.includes('no-source')));
    const noColumn = await publish(STAT_DOC('source="tbl_1" agg="avg"'));
    assert.ok(noColumn.lines.some(l => l.includes('no-column')));
    assert.strictEqual(/bf-stat-value/.test(noColumn.clean), false);
});

test('a column full of text yields no number rather than a zero', async () => {
    // Een 0 leest als een echt antwoord. "Er valt hier niets op te tellen" niet.
    const rows = [{ id: 'r1', name: 'Basic', price: 'n/a' }, { id: 'r2', name: 'Plus', price: '' }];
    const res = await publish(STAT_DOC('source="tbl_1" agg="sum" column="price"'), stubs({ rows }));
    assert.strictEqual(/bf-stat-value/.test(res.clean), false);
    assert.ok(res.lines.some(l => l.includes('no-number')));
});

test('a refused read and an outage look identical from the outside', async () => {
    const refusal = new datatableRuntime.DatatableRuntimeError(404, 'datatable_not_found', 'Not found');
    const refused = await publish(STAT_DOC('source="tbl_1"'), stubs({ throwOnRead: refusal }));
    const outage = await publish(STAT_DOC('source="tbl_1"'), stubs({ throwOnRead: new Error('pg down') }));
    assert.strictEqual(refused.clean, outage.clean,
        'een anonieme lezer mag "mag niet" en "kapot" niet uit elkaar kunnen houden');
    assert.ok(refused.lines.some(l => l.includes('unavailable')));
    assert.ok(outage.lines.some(l => l.includes('read-failed')));
});

// ── de drie die hier niets kunnen ─────────────────────────────────────

test('BITE — bf-button becomes a visibly disabled button with a notice, not a bare word', async () => {
    // Zonder uitklappen maakt DOMPurify hier letterlijk `Send order` van: tag
    // weg, attributen weg, geen waarschuwing. De lezer ziet dan losse tekst waar
    // een knop hoorde te staan.
    const { clean } = await publish('<html><body><bf-button run="a1">Send order</bf-button></body></html>');
    const notice = bfElements.getBfElement('bf-button').surfaces.vanillaSnapshot.notice;
    assert.match(clean, /<div class="bf-inert bf-button">/);
    assert.match(clean, /<button type="button" disabled="">Send order<\/button>/);
    assert.ok(clean.includes(notice), `de melding "${notice}" moet de sanitizer overleven`);
    assertNoBfElementsLeft(clean);
    // De vergelijking die het punt maakt: zónder uitklappen blijft er niets over
    // waaruit een lezer kan opmaken dat hier iets stond.
    const raw = webpageSnapshot.sanitizeHtml('<bf-button run="a1">Send order</bf-button>');
    assert.strictEqual(raw.trim(), 'Send order');
    assert.strictEqual(raw.includes(notice), false);
});

test('BITE — bf-form keeps its fields, disables every one of them, and never emits a <form>', async () => {
    // `form` staat in FORBID_TAGS van de sanitizer en KEEP_CONTENT laat de velden
    // dan los staan — een half formulier zonder knop. Dus: geen <form>.
    const { clean } = await publish(
        '<html><body><bf-form automation="a1" submit-label="Send">'
        + '<input name="email" type="email"><textarea name="msg"></textarea>'
        + '</bf-form></body></html>');
    const notice = bfElements.getBfElement('bf-form').surfaces.vanillaSnapshot.notice;
    assert.strictEqual(/<form/i.test(clean), false, 'een <form> overleeft de sanitizer niet');
    assert.match(clean, /<input name="email" type="email" disabled="">/);
    assert.match(clean, /<textarea name="msg" disabled="">/);
    assert.match(clean, /<button type="button" disabled="">Send<\/button>/);
    assert.ok(clean.includes(notice));
    assertNoBfElementsLeft(clean);
});

test('BITE — bf-agent keeps what the author wrote and says the assistant is not there', async () => {
    const { clean } = await publish(
        '<html><body><bf-agent placeholder="Ask about the menu">Ask me anything</bf-agent></body></html>');
    const notice = bfElements.getBfElement('bf-agent').surfaces.vanillaSnapshot.notice;
    assert.match(clean, /Ask me anything/, 'wat de auteur schreef is van hem en blijft staan');
    assert.match(clean, /<input type="text" placeholder="Ask about the menu" disabled="">/);
    assert.ok(clean.includes(notice));
    assertNoBfElementsLeft(clean);
});

test('BITE — every element that needs JS carries its own notice through the sanitizer', async () => {
    // De regel zelf, over het hele vocabulaire in plaats van per element: geen
    // enkel JS-element mag stil verdwijnen, wat er ook aan wordt toegevoegd.
    const tags = bfElements.tagsNeedingJs();
    assert.ok(tags.length >= 3, 'sanity: er zijn elementen die JS nodig hebben');
    for (const tag of tags) {
        const { clean } = await publish(`<html><body><${tag}></${tag}></body></html>`);
        const notice = bfElements.getBfElement(tag).surfaces.vanillaSnapshot.notice;
        assert.ok(clean.includes(notice), `${tag} verdwijnt zonder melding uit de gepubliceerde kopie`);
        assert.match(clean, new RegExp(`<div class="bf-inert ${tag}">`));
        assertNoBfElementsLeft(clean);
    }
});

test('a page with only inert elements never reads a single binding', async () => {
    // Een knop heeft geen tabel nodig; dan hoort er ook geen grant te worden
    // opgevraagd en geen principal te worden opgelost.
    let asked = false;
    let resolved = false;
    await withPatches([
        [bridgeGrants, 'getBridgeGrants', async () => { asked = true; return {}; }],
        [dtAccess, 'resolveDatatablePrincipalForUser', async () => { resolved = true; return null; }],
    ], async () => {
        const res = await withLog(() => bfTable.expandBfElements(
            '<html><body><bf-button run="a1">Go</bf-button><bf-agent></bf-agent></body></html>',
            { webpageId: 'wp1', ownerId: OWNER }));
        assert.match(res.out, /bf-inert bf-button/);
        assert.strictEqual(asked, false);
        assert.strictEqual(resolved, false);
    });
});

// ── de hele pagina in één keer ────────────────────────────────────────

test('BITE — all five elements on one page: two carry data, three carry a notice, none survive as a tag', async () => {
    const doc = '<html><body>'
        + '<h1>Menu</h1>'
        + '<bf-table source="tbl_1"></bf-table>'
        + '<bf-stat source="tbl_1" agg="sum" column="price" label="Turnover"></bf-stat>'
        + '<bf-button run="a1">Order</bf-button>'
        + '<bf-form automation="a1"><input name="email"></bf-form>'
        + '<bf-agent></bf-agent>'
        + '</body></html>';
    const { clean } = await publish(doc);

    assert.match(clean, /<table class="bf-table">/);
    assert.match(clean, /<td>Basic<\/td>/);
    assert.strictEqual(/Margin/.test(clean), false, 'een niet-publieke kolom blijft weg, ook naast andere elementen');
    assert.match(clean, /<span class="bf-stat-value">25<\/span>/);
    for (const tag of bfElements.tagsNeedingJs()) {
        assert.ok(clean.includes(bfElements.getBfElement(tag).surfaces.vanillaSnapshot.notice));
    }
    assertNoBfElementsLeft(clean);
});

// ── sluitronde: wat er nog stil kon verdwijnen ────────────────────────

test('een zelfsluitend geschreven element slokt de rest van de pagina niet op', async () => {
    // Een custom element KAN in HTML niet zelfsluitend zijn: de parser leest
    // `<bf-table … />` als een openingstag en stopt de hele rest van het
    // document erin als kinderen — die daarna met `replaceWith` wegvallen. De
    // bouwer-prompt vertelt het model sinds W4 actief om deze elementen te
    // schrijven, en `/>` is precies de gewoonte die het uit JSX meebrengt.
    const doc = '<html><body><bf-table source="tbl_1"/><h2>Rest of page</h2><p>tail</p></body></html>';
    const { clean } = await publish(doc);
    assert.match(clean, /<table class="bf-table">/);
    assert.ok(clean.includes('<h2>Rest of page</h2>'), 'alles ná het element hoort er nog te staan');
    assert.ok(clean.includes('<p>tail</p>'));
    assertNoBfElementsLeft(clean);
});

test('een zelfsluitend formulier trekt niet de hele pagina zijn inerte blok in', async () => {
    const doc = '<html><body><bf-form automation="a1"/><h2>Rest</h2></body></html>';
    const { clean } = await publish(doc);
    assert.ok(clean.includes('<h2>Rest</h2>'));
    assert.ok(clean.includes(bfElements.getBfElement('bf-form').surfaces.vanillaSnapshot.notice));
    assertNoBfElementsLeft(clean);
});

test('een element in een <template> verdwijnt niet spoorloos', async () => {
    // `querySelectorAll` kijkt niet in `template.content`, dus dit element werd
    // overgeslagen — en DOMPurify pakte het daarna zonder waarschuwing uit. Het
    // enige geval waarin een BEKEND element net zo stil weg was als een onbekend.
    const doc = '<html><body><template><bf-button run="a1">Go</bf-button></template></body></html>';
    const { clean } = await publish(doc);
    assert.ok(clean.includes(bfElements.getBfElement('bf-button').surfaces.vanillaSnapshot.notice));
    assertNoBfElementsLeft(clean);
});

test('"niet gebonden" en "de bindingen waren niet te lezen" krijgen een eigen reden in het log', async () => {
    const patches = stubs();
    // Zelfde bytes naar buiten (een anonieme lezer mag dat verschil niet zien),
    // maar aan de beheerderskant moet het uit elkaar te houden blijven: de
    // reconciler herschrijft de snapshot bij ELKE tabelmutatie, dus één
    // databankhikje zou de pagina stil opnieuw publiceren met een lege tabel.
    const broken = patches.map(([obj, key, value]) => (
        key === 'getBridgeGrants' ? [obj, key, async () => { throw new Error('db down'); }] : [obj, key, value]
    ));
    const notBound = await publish('<html><body><bf-table source="tbl_9"></bf-table></body></html>');
    const unreadable = await publish('<html><body><bf-table source="tbl_9"></bf-table></body></html>', broken);
    assert.ok(notBound.lines.some(l => l.includes('bf-table:not-bound')));
    assert.ok(unreadable.lines.some(l => l.includes('bf-table:bindings-unreadable')));
    assert.strictEqual(notBound.clean, unreadable.clean, 'de bytes naar buiten blijven gelijk');
});

test('het getal gaat over de rijgrens uit de registry, niet over wat er toevallig komt', async () => {
    let asked = null;
    const patches = stubs({ onRead: (opts) => { asked = opts; } });
    await publish('<html><body><bf-stat source="tbl_1" agg="sum" column="price"></bf-stat></body></html>', patches);
    assert.strictEqual(asked.limit, bfElements.getBfElement('bf-stat').reads.rowsMax,
        'zonder deze grens rekent de gepubliceerde pagina over een ander aantal rijen dan de preview');
});

test('een cel wordt afgekapt, zodat één rij geen pagina wordt', async () => {
    const long = 'x'.repeat(2000);
    const { clean } = await publish(
        '<html><body><bf-table source="tbl_1"></bf-table></body></html>',
        stubs({ rows: [{ id: 'r1', name: long, price: 1 }] }),
    );
    const cell = /<td>(x+)<\/td>/.exec(clean);
    assert.ok(cell, 'sanity: de cel staat in de uitvoer');
    assert.strictEqual(cell[1].length, 500, 'de bovengrens per cel wordt echt toegepast');
});

test('de handelingstabel moet ook een VORM voor elk inert element hebben', () => {
    // Spiegelbeeld van de expand-kant. Zonder deze richting was INERT_BODY een
    // tweede, ongecontroleerde lijst: een nieuw inert element kreeg wel zijn
    // melding maar geen uitgeschakelde knop of veld, en niets zei dat die er
    // hoorde te zijn.
    assert.throws(
        () => bfTable._assertHandlingIsWorkable(bfTable.VANILLA_HANDLING, undefined, {}),
        /INERT_BODY zegt niets over zijn vorm/,
    );
});

test('elke aggregatie die het vocabulaire kent, heeft ook een uitvoering', () => {
    assert.strictEqual(bfTable._assertAggregationsAreImplemented(), true);
    assert.throws(
        () => bfTable._assertAggregationsAreImplemented(['count', 'median']),
        /kent geen uitvoering voor median/,
        'een zesde aggregatie in de registry mag niet stil op "geen getal" uitkomen — dat is niet te '
        + 'onderscheiden van "er viel niets op te tellen"',
    );
    assert.throws(
        () => bfTable._assertAggregationsAreImplemented(['count']),
        /voert .* uit, en dat kent bf-stat niet/,
    );
});

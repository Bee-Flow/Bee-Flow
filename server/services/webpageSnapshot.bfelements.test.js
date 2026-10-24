/**
 * services/webpageSnapshot — what remains of the `bf-*` vocabulary in the VANILLA
 * public snapshot.
 *
 * The neighbourhood test of webpageSnapshot.reactshare.test.js, which looks at the same writer from the
 * OTHER side (which slot receives the bytes). Here it is about the bytes
 * themselves: what does an anonymous visitor see on /w/<slug>?
 *
 * ── WHAT THIS TEST GUARDS ───────────────────────────────────────────
 *
 * Two rules, and they point in opposite directions:
 *
 *   1. `publicColumns` is THE gate and the ONLY gate. `bf-stat` summarises data,
 *      and a summary of a column is still that column — so the column being summed
 *      must itself be public, and a table without a public
 *      column yields no `count` either.
 *   2. What cannot work in this snapshot must SAY so itself. There is no JS
 *      running here, so `bf-button` / `bf-form` / `bf-agent` are dead — and
 *      "dead" is allowed, "silent" is not.
 *
 * Rule 2 cannot be proven with expander output alone: everything then still goes
 * through DOMPurify, and that is exactly where things vanish without warning
 * (`KEEP_CONTENT: true`, `ADD_TAGS` knows only `iframe`, and `form` is in
 * FORBID_TAGS). That is why every output below runs through the REAL
 * `webpageSnapshot.sanitizeHtml` before anything is claimed about it. A
 * notice block that the sanitiser does not survive is exactly as silent as no
 * notice block at all.
 *
 * Run: cd server && node --test --test-force-exit services/webpageSnapshot.bfelements.test.js
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

/** Captures the log; reason codes belong there and nowhere else. */
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

/** No single `bf-*` element may get into the snapshot — expanded or not. */
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
    // `margin` is in the binding (`columns`) but not in `publicColumns`.
    // A sum over that column would publish that column after all — summarised, but
    // it is the same data — so the gate must close here, and BEFORE the read.
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
    // "Empty means NO column" must also apply to a number that names no column:
    // how many rows there are is a statement about that table, and about a
    // table of which nothing is public we make no statements.
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
    // A sum over the first 500 of 5000 rows is not "roughly right": it is
    // wrong, and the number does not show that.
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
    // A 0 reads as a real answer. "There is nothing to add up here" does not.
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
    // Without expanding, DOMPurify literally turns this into `Send order`: tag
    // gone, attributes gone, no warning. The reader then sees loose text where
    // a button should have stood.
    const { clean } = await publish('<html><body><bf-button run="a1">Send order</bf-button></body></html>');
    const notice = bfElements.getBfElement('bf-button').surfaces.vanillaSnapshot.notice;
    assert.match(clean, /<div class="bf-inert bf-button">/);
    assert.match(clean, /<button type="button" disabled="">Send order<\/button>/);
    assert.ok(clean.includes(notice), `de melding "${notice}" moet de sanitizer overleven`);
    assertNoBfElementsLeft(clean);
    // The comparison that makes the point: without expanding, nothing remains
    // from which a reader could tell that something had stood here.
    const raw = webpageSnapshot.sanitizeHtml('<bf-button run="a1">Send order</bf-button>');
    assert.strictEqual(raw.trim(), 'Send order');
    assert.strictEqual(raw.includes(notice), false);
});

test('BITE — bf-form keeps its fields, disables every one of them, and never emits a <form>', async () => {
    // `form` is in the sanitiser's FORBID_TAGS and KEEP_CONTENT then leaves the fields
    // standing — a half form without a button. So: no <form>.
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
    // The rule itself, over the whole vocabulary instead of per element: no
    // single JS element may vanish silently, whatever is added to it.
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
    // A button needs no table; then no grant should be requested
    // and no principal resolved either.
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
    // A custom element CANNOT be self-closing in HTML: the parser reads
    // `<bf-table … />` as an opening tag and puts the whole rest of the
    // document inside it as children — which then drop out with `replaceWith`. The
    // builder prompt has actively told the model since W4 to write these
    // elements, and `/>` is exactly the habit it brings from JSX.
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
    // `querySelectorAll` does not look inside `template.content`, so this element was
    // skipped — and DOMPurify then unwrapped it without a warning. The
    // only case in which a KNOWN element went as silently missing as an unknown one.
    const doc = '<html><body><template><bf-button run="a1">Go</bf-button></template></body></html>';
    const { clean } = await publish(doc);
    assert.ok(clean.includes(bfElements.getBfElement('bf-button').surfaces.vanillaSnapshot.notice));
    assertNoBfElementsLeft(clean);
});

test('"niet gebonden" en "de bindingen waren niet te lezen" krijgen een eigen reden in het log', async () => {
    const patches = stubs();
    // Same bytes outward (an anonymous reader must not be able to see that
    // difference), but on the admin side it must stay distinguishable: the
    // reconciler rewrites the snapshot on EVERY table mutation, so one
    // database hiccup would silently republish the page with an empty table.
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
    // The mirror image of the expand side. Without this direction INERT_BODY was a
    // second, unchecked list: a new inert element got its notice but no
    // disabled button or field, and nothing said that one should be there.
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

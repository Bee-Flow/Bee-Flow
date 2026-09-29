/**
 * services/webpageBfTable — de PUBLIEKE kant van een tabelbinding.
 *
 * Geen databank: de grant-lezer, de principal-resolver en de runner worden
 * gemonkeypatcht. Wat hier getoetst wordt is de poort zelf: dat er precies
 * `publicColumns` naar buiten gaat en niets meer, dat alles wat misgaat een
 * leeg blok oplevert, en dat een waarde uit een rij nooit als HTML landt.
 *
 * Draaien: cd server && node --test --test-force-exit services/webpageBfTable.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const bridgeGrants = require('../stores/webpage/bridgeGrants');
const dtAccess = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const bfTable = require('./webpageBfTable');

const OWNER = 'u-owner';

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return Promise.resolve().then(fn).finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

/**
 * Vangt op wat emptyBlock naar het log schrijft. De reden-code van een leeg
 * blok hoort DAAR te staan — en nergens in de uitvoer, want die uitvoer gaat
 * ongewijzigd (data-* overleeft DOMPurify) naar een anonieme lezer op /w/<slug>.
 */
async function withLog(fn) {
    const lines = [];
    const orig = console.warn;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    try { return { out: await fn(), lines }; }
    finally { console.warn = orig; }
}

/** De reden-code staat in het log en nergens in de bytes die naar buiten gaan. */
function assertReasonLoggedNotPublished({ out, lines }, reason) {
    assert.strictEqual(/data-bf-table/.test(out), false,
        'een reden-code mag niet in de publieke snapshot staan');
    assert.strictEqual(new RegExp(reason).test(out), false,
        `de reden "${reason}" mag nergens in de uitvoer staan`);
    assert.ok(lines.some(l => l.includes(reason)),
        `de reden "${reason}" hoort wel in het log te staan`);
}

const META = {
    key: 'rates',
    fields: [
        { id: 'f1', key: 'name', label: 'Product' },
        { id: 'f2', key: 'price', label: 'Price' },
        { id: 'f3', key: 'margin', label: 'Margin' },
    ],
};

function stubs({ tables = [], rows = [], readColumns = null, onRead = null, throwOnRead = null } = {}) {
    return [
        [bridgeGrants, 'getBridgeGrants', async () => ({ ai: {}, automations: [], integrations: [], tables, agent: null })],
        [dtAccess, 'resolveDatatablePrincipalForUser', async (id) => ({ userId: id, orgId: 'org-1', organizationId: 'org-1', orgRole: null, groupIds: [] })],
        [datatableRuntime, 'resolveForPrincipal', async () => ({ meta: META, grade: 'viewer' })],
        [datatableRuntime, 'readRows', async (_r, opts) => {
            if (onRead) onRead(opts);
            if (throwOnRead) throw throwOnRead;
            const cols = readColumns || opts.allowColumns;
            return { rows, columns: cols, hasMore: false, count: rows.length, nextCursor: null };
        }],
    ];
}

const BINDING = {
    datatableId: 'tbl_1',
    mode: 'readwrite',
    columns: ['name', 'price', 'margin'],
    publicColumns: ['name', 'price'],
};

const DOC = '<html><body><h1>Rates</h1><bf-table source="tbl_1"></bf-table></body></html>';

test('html without a bf-table is returned untouched, and nothing is read', async () => {
    let asked = false;
    await withPatches([[bridgeGrants, 'getBridgeGrants', async () => { asked = true; return {}; }]], async () => {
        const out = await bfTable.expandBfElements('<html><body><p>hi</p></body></html>', { webpageId: 'wp1', ownerId: OWNER });
        assert.strictEqual(out, '<html><body><p>hi</p></body></html>');
        assert.strictEqual(asked, false);
    });
});

test('BITE — only publicColumns reach the snapshot, never the binding\'s own columns', async () => {
    let seen = null;
    await withPatches(stubs({
        tables: [BINDING],
        rows: [{ id: 'r1', name: 'Basic', price: 10, updated_at: 't' }],
        onRead: (o) => { seen = o; },
    }), async () => {
        const out = await bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER });
        assert.deepStrictEqual(seen.allowColumns, ['name', 'price'],
            'the reader must be handed publicColumns, not columns');
        assert.match(out, /<table class="bf-table">/);
        assert.match(out, /<th>Product<\/th>/);
        assert.match(out, /<th>Price<\/th>/);
        assert.strictEqual(/Margin/.test(out), false, 'an internal-only column may not appear');
        assert.match(out, /<td>Basic<\/td>/);
        assert.strictEqual(/<bf-table/.test(out), false, 'the custom element itself must be gone');
    });
});

test('BITE — an empty publicColumns publishes nothing and never reads the table', async () => {
    let read = false;
    await withPatches(stubs({
        tables: [{ ...BINDING, publicColumns: [] }],
        rows: [{ id: 'r1', name: 'Basic' }],
        onRead: () => { read = true; },
    }), async () => {
        const res = await withLog(() => bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER }));
        assertReasonLoggedNotPublished(res, 'no-public-columns');
        assert.strictEqual(/Basic/.test(res.out), false);
        assert.strictEqual(read, false, 'nothing may be read when no column is public');
    });
});

test('a table this page is not bound to renders an empty block', async () => {
    await withPatches(stubs({ tables: [], rows: [{ id: 'r1', name: 'x' }] }), async () => {
        const res = await withLog(() => bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER }));
        assertReasonLoggedNotPublished(res, 'not-bound');
        assert.strictEqual(/<table/.test(res.out), false);
    });
});

test('BITE — a refusal and an outage stay distinguishable IN THE LOG, never in the snapshot', async () => {
    const refusal = new datatableRuntime.DatatableRuntimeError(404, 'datatable_not_found', 'Not found');
    let refusedHtml = null;
    let outageHtml = null;
    await withPatches(stubs({ tables: [BINDING], throwOnRead: refusal }), async () => {
        const res = await withLog(() => bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER }));
        assertReasonLoggedNotPublished(res, 'unavailable');
        refusedHtml = res.out;
    });
    await withPatches(stubs({ tables: [BINDING], throwOnRead: new Error('pg down') }), async () => {
        const res = await withLog(() => bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER }));
        assertReasonLoggedNotPublished(res, 'read-failed');
        outageHtml = res.out;
    });
    // De kern: twee verschillende toestanden, exact dezelfde publieke bytes.
    // Zo valt er voor een anonieme lezer niets uit af te leiden.
    assert.strictEqual(refusedHtml, outageHtml,
        'een geweigerde en een onbereikbare tabel moeten er naar buiten toe identiek uitzien');
});

test('BITE — zero rows logs "empty" but publishes the same block as every other reason', async () => {
    let emptyHtml = null;
    await withPatches(stubs({ tables: [BINDING], rows: [] }), async () => {
        const res = await withLog(() => bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER }));
        assertReasonLoggedNotPublished(res, 'empty');
        emptyHtml = res.out;
    });
    // Een lege tabel en een niet-gebonden tabel geven dezelfde bytes: de
    // snapshot verklapt niet dat de tabel nul rijen heeft in plaats van iets
    // anders, en verspringt dus ook niet zichtbaar bij de eerste rij.
    await withPatches(stubs({ tables: [] }), async () => {
        const res = await withLog(() => bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER }));
        assert.strictEqual(res.out, emptyHtml,
            '"nul rijen" en "niet gebonden" moeten er naar buiten toe identiek uitzien');
    });
});

test('BITE — a cell value that looks like HTML lands as text, not as markup', async () => {
    await withPatches(stubs({
        tables: [BINDING],
        rows: [{ id: 'r1', name: '<img src=x onerror="alert(1)">', price: '</td><script>bad()</script>' }],
    }), async () => {
        const out = await bfTable.expandBfElements(DOC, { webpageId: 'wp1', ownerId: OWNER });
        assert.strictEqual(/<img/.test(out), false);
        assert.strictEqual(/<script>bad/.test(out), false);
        assert.match(out, /&lt;img src=x onerror=/);
    });
});

test('the row limit is clamped to the public maximum, whatever the element asks for', async () => {
    const seen = [];
    await withPatches(stubs({ tables: [BINDING], rows: [{ id: 'r1', name: 'a' }], onRead: (o) => seen.push(o.limit) }), async () => {
        await bfTable.expandBfElements(
            '<html><body><bf-table source="tbl_1" limit="99999"></bf-table>'
            + '<bf-table source="tbl_1" limit="5"></bf-table>'
            + '<bf-table source="tbl_1" limit="nonsense"></bf-table></body></html>',
            { webpageId: 'wp1', ownerId: OWNER });
        assert.deepStrictEqual(seen, [bfTable.PUBLIC_ROWS_MAX, 5, bfTable.PUBLIC_ROWS_MAX]);
    });
});

test('BITE — een onbekend bf-element wordt gemeld, niet stil doorgelaten', async () => {
    // DOMPurify pakt `<bf-widget>` straks zonder één waarschuwing uit
    // (KEEP_CONTENT: true, ADD_TAGS kent alleen `iframe`): de tag verdwijnt, de
    // attributen verdwijnen, de tekst blijft staan. Wie wil weten DÁT er iets
    // onbekends in een gepubliceerde pagina stond, moet het hiervóór tellen.
    let asked = false;
    await withPatches([[bridgeGrants, 'getBridgeGrants', async () => { asked = true; return {}; }]], async () => {
        const src = '<html><body><bf-widget action="x">Klik</bf-widget></body></html>';
        const res = await withLog(() => bfTable.expandBfElements(src, { webpageId: 'wp1', ownerId: OWNER }));
        assert.strictEqual(res.out, src, 'we raken hem niet aan — alleen melden');
        assert.strictEqual(asked, false, 'een onbekend element is nog steeds geen reden om grants te lezen');
        assert.ok(res.lines.some(l => l.includes('bf-widget')),
            'de naam van het onbekende element hoort in het log te staan');
    });
});

test('een onbekend element naast een bekende tabel houdt de tabel gewoon heel', async () => {
    await withPatches(stubs({ tables: [BINDING], rows: [{ id: 'r1', name: 'Basic', price: 10 }] }), async () => {
        const res = await withLog(() => bfTable.expandBfElements(
            '<html><body><bf-widget></bf-widget><bf-table source="tbl_1"></bf-table></body></html>',
            { webpageId: 'wp1', ownerId: OWNER }));
        assert.match(res.out, /<td>Basic<\/td>/);
        assert.ok(res.lines.some(l => l.includes('bf-widget')));
    });
});

test('a bf-table without a source renders an empty block', async () => {
    await withPatches(stubs({ tables: [BINDING] }), async () => {
        const res = await withLog(() => bfTable.expandBfElements('<html><body><bf-table></bf-table></body></html>',
            { webpageId: 'wp1', ownerId: OWNER }));
        assertReasonLoggedNotPublished(res, 'no-source');
    });
});

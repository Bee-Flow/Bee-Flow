/**
 * A datatable as a knowledge source.
 *
 * ── THE TWO PROPERTIES THAT CARRY IT ────────────────────────────────
 * A datatable has row-level access rules of its own, and they are not
 * decoration: a table can be readable by everyone while individual rows are
 * not. So the enumerate compiles the SAME access predicate the routine runner
 * and the routes compile — as the KNOWLEDGE BASE'S OWNER, because a scheduled
 * pass has nobody pressing anything.
 *
 * And `compileRecordList` asks for `limit + 1` as a cursor probe. EVERY caller
 * must slice it off; `stepDataSource.js` records the bug where that extra row
 * leaked into an AI prompt. Here it would become a document.
 *
 * Run: cd server && node --test --test-force-exit core/kb/sources/datatable.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const adapter = require('./datatable');

const META = {
    key: 'products',
    fields: [
        { key: 'name', type: 'text' },
        { key: 'price', type: 'number' },
        { key: 'notes', type: 'text' },
    ],
};

function row(i, over = {}) {
    return {
        id: `r${i}`, name: `Product ${i}`, price: 10 + i, notes: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: `2026-07-2${i % 10}T10:00:00.000Z`,
        ...over,
    };
}

/**
 * The real compiler and the real access filter would need a database. What is
 * under test is which rows become documents and what the documents say, so
 * both are recorded rather than executed — and the recording is what proves
 * the access filter was compiled at all.
 */
function deps(rows, calls = {}) {
    calls.access = calls.access || [];
    calls.queries = calls.queries || [];
    calls.resolve = calls.resolve || [];
    let served = 0;
    return {
        calls,
        datatableResolve: {
            resolveDatatableForStep: async (id, ctx, opts) => {
                calls.resolve.push({ id, ctx, opts });
                if (calls.resolveThrows) throw new Error(calls.resolveThrows);
                return {
                    table: { id, name: 'Products', rowCount: calls.rowCount ?? 3 },
                    tableMeta: META, grade: 'viewer', scopeKey: 'org_1',
                };
            },
        },
        accessFilter: {
            compileAccessFilter: (meta, grade, viewer, action) => {
                calls.access.push({ grade, viewer, action });
                return { sql: 'owner_id = ?', params: ['owner1'] };
            },
        },
        queryCompiler: {
            compileRecordList: (meta, opts, filter) => {
                calls.queries.push({ opts, filter });
                return { sql: 'SELECT …', params: [], primaryField: 'name', limit: opts.limit };
            },
            encodeCursor: (v, i) => `${v}|${i}`,
        },
        datatableDbStore: {
            query: async (_a, _b, _sql, _params) => {
                // Serve a page plus the probe row the compiler asks for, the
                // way the real store does.
                const limit = calls.queries.at(-1).opts.limit;
                const page = rows.slice(served, served + limit + 1);
                served += Math.min(limit, page.length);
                return { rows: page };
            },
        },
    };
}

const ctx = (over = {}) => ({ kb: { id: 'kb1', tenant_id: 'owner1' }, kbId: 'kb1', ...over });
const source = (config = { datatableId: 'dt1' }) => ({ id: 's1', kind: 'datatable', config });

// ── Access ──────────────────────────────────────────────────────────

test('the rows are read as the KNOWLEDGE BASE owner', async () => {
    const d = deps([row(1)]);
    await adapter.enumerate(source(), ctx(), d);
    assert.strictEqual(d.calls.resolve[0].ctx.userId, 'owner1');
    assert.strictEqual(d.calls.resolve[0].opts.needed, 'viewer', 'a source never needs to write');
});

test('the table`s own row access filter is compiled, every pass', async () => {
    // A table can be readable by everyone while individual rows are not.
    // Skipping this would put rows in a knowledge base that their own table
    // hides from the owner.
    const d = deps([row(1)]);
    await adapter.enumerate(source(), ctx(), d);
    assert.strictEqual(d.calls.access.length, 1);
    assert.deepStrictEqual(d.calls.access[0], { grade: 'viewer', viewer: { id: 'owner1' }, action: 'read' });
    assert.ok(d.calls.queries[0].filter, 'and handed to the query, not computed and dropped');
});

test('a knowledge base with no owner enumerates nothing', async () => {
    const d = deps([row(1)]);
    assert.deepStrictEqual(await adapter.enumerate(source(), ctx({ kb: { id: 'kb1' } }), d), []);
    assert.deepStrictEqual(d.calls.resolve, [], 'and asks the table nothing');
});

test('a source with no table enumerates nothing', async () => {
    const d = deps([row(1)]);
    assert.deepStrictEqual(await adapter.enumerate(source({}), ctx(), d), []);
});

test('a table the owner can no longer read FAILS rather than emptying the base', async () => {
    // Returning [] would make syncSource delete every document this source
    // holds. That is right for "the rows are gone" and wrong for "we could not
    // ask", and the two must not look the same.
    const d = deps([]);
    d.calls.resolveThrows = 'datatable_not_found';
    await assert.rejects(() => adapter.enumerate(source(), ctx(), d), /no longer available/);
});

// ── The probe row ───────────────────────────────────────────────────

test('the compiler`s probe row never becomes a document', async () => {
    // compileRecordList asks for limit+1 to know whether there is a next page.
    // stepDataSource.js records the bug where that extra row leaked into an AI
    // prompt; here it would become a document of somebody else's data.
    const rows = Array.from({ length: 5 }, (_, i) => row(i));
    const d = deps(rows);
    // Force a small page so the probe is exercised.
    d.queryCompiler.compileRecordList = (meta, opts, filter) => {
        d.calls.queries.push({ opts, filter });
        return { sql: 'x', params: [], primaryField: 'name', limit: 2 };
    };
    const items = await adapter.enumerate(source(), ctx(), d);
    const ids = items.map(i => i.externalId);
    assert.strictEqual(new Set(ids).size, ids.length, 'no row appears twice');
    assert.ok(ids.length <= rows.length);
});

// ── The documents ───────────────────────────────────────────────────

test('one row is one document, named by its own first column', async () => {
    const d = deps([row(1)]);
    const [item] = await adapter.enumerate(source(), ctx(), d);
    assert.strictEqual(item.externalId, 'row:r1');
    assert.strictEqual(item.title, 'Product 1');
    const doc = await adapter.fetch(item);
    assert.strictEqual(doc.content, 'name: Product 1\nprice: 11');
    assert.strictEqual(doc.sourceType, 'datatable');
    assert.deepStrictEqual(doc.metadata.rowIds, ['r1']);
});

test('a titleColumn names the row when one is chosen', async () => {
    const d = deps([row(1, { notes: 'Winterkorting' })]);
    const [item] = await adapter.enumerate(source({ datatableId: 'dt1', titleColumn: 'notes' }), ctx(), d);
    assert.strictEqual(item.title, 'Winterkorting');
});

test('an empty cell is left out, not written as "column:"', async () => {
    // A line saying a column exists and is empty is noise in every chunk it
    // appears in.
    assert.strictEqual(adapter.renderRow({ name: 'X', price: null, notes: '' }, ['name', 'price', 'notes']), 'name: X');
});

test('column names ride along, because that is what makes a row answerable', () => {
    // "prijs: 12,50" retrieves for "wat kost"; a bare "12,50" retrieves for
    // nothing.
    assert.match(adapter.renderRow({ prijs: '12,50' }, ['prijs']), /^prijs: 12,50$/);
});

test('a cell that is not a string reads as a person would write it', () => {
    assert.strictEqual(adapter.formatCell({ a: 1 }), '{"a":1}');
    assert.strictEqual(adapter.formatCell([1, 2]), '[1,2]');
    assert.strictEqual(adapter.formatCell(new Date('2026-07-22T10:00:00Z')), '2026-07-22T10:00:00.000Z');
    assert.strictEqual(adapter.formatCell(12.5), '12.5');
    assert.strictEqual(adapter.formatCell(false), 'false');
});

test('a row with nothing in it produces no document', async () => {
    const d = deps([row(1, { name: '', price: null, notes: '' })]);
    const [item] = await adapter.enumerate(source(), ctx(), d);
    assert.strictEqual(await adapter.fetch(item), null);
});

// ── Columns ─────────────────────────────────────────────────────────

test('the columns a source chose are the columns it gets', async () => {
    const d = deps([row(1, { notes: 'iets' })]);
    const [item] = await adapter.enumerate(source({ datatableId: 'dt1', columns: ['price'] }), ctx(), d);
    const doc = await adapter.fetch(item);
    assert.strictEqual(doc.content, 'price: 11');
});

test('system columns are never quoted at a person', () => {
    // Nobody wrote `updated_by`, and nobody wants it read back to them in an
    // answer.
    const cols = adapter.pickColumns({}, {
        fields: [{ key: 'id' }, { key: 'name' }, { key: 'created_at' }, { key: 'updated_by' }],
    });
    assert.deepStrictEqual(cols, ['name']);
});

test('a column the table no longer has is dropped, not queried', () => {
    // The source stored it when the column existed; the table has moved on.
    assert.deepStrictEqual(adapter.pickColumns({ columns: ['name', 'gone'] }, META), ['name']);
    assert.deepStrictEqual(adapter.pickColumns({ columns: ['gone'] }, META), ['name', 'price', 'notes'],
        'nothing valid left falls back to everything, rather than to nothing');
});

// ── Change detection ────────────────────────────────────────────────

test('a row nobody has written is unchanged, and costs no rebuild', async () => {
    const d = deps([row(1)]);
    const [item] = await adapter.enumerate(source(), ctx(), d);
    assert.strictEqual(adapter.isUnchanged(item, { source_modified_at: item.sourceModifiedAt }), true);
    assert.strictEqual(adapter.isUnchanged(item, { source_modified_at: '2020-01-01T00:00:00.000Z' }), false);
    assert.strictEqual(adapter.isUnchanged(item, null), false);
});

// ── Big tables ──────────────────────────────────────────────────────

describe_chunking();
function describe_chunking() {
    test('a table above the threshold groups rows instead of exploding', async () => {
        // Fifty thousand documents to hold a lookup table would swamp every
        // other source in the knowledge base and cost fifty thousand
        // embeddings.
        const rows = Array.from({ length: adapter.CHUNK_ABOVE_ROWS + 10 }, (_, i) => row(i));
        const d = deps(rows);
        d.calls.rowCount = rows.length;
        d.queryCompiler.compileRecordList = (meta, opts, filter) => {
            d.calls.queries.push({ opts, filter });
            return { sql: 'x', params: [], primaryField: 'name', limit: 100_000 };
        };
        const items = await adapter.enumerate(source(), ctx(), d);
        assert.ok(items.length < rows.length / 10, 'grouped, not one each');
        assert.match(items[0].externalId, /^rows:0-/);
        const doc = await adapter.fetch(items[0]);
        assert.ok(doc.metadata.rowIds.length > 1);
    });

    test('a block is keyed on its POSITION, not on its first row', async () => {
        // Keyed on the first row's id, inserting a row at the top would
        // renumber every block and re-embed the whole table.
        const rows = Array.from({ length: adapter.CHUNK_ABOVE_ROWS + 10 }, (_, i) => row(i));
        const d = deps(rows);
        d.calls.rowCount = rows.length;
        d.queryCompiler.compileRecordList = (meta, opts, filter) => {
            d.calls.queries.push({ opts, filter });
            return { sql: 'x', params: [], primaryField: 'name', limit: 100_000 };
        };
        const items = await adapter.enumerate(source(), ctx(), d);
        for (const item of items) assert.match(item.externalId, /^rows:\d+-\d+$/);
    });

    test('a block is changed when ANY row in it was written', async () => {
        const rows = Array.from({ length: adapter.CHUNK_ABOVE_ROWS + 10 }, (_, i) => row(i));
        rows[3].updated_at = '2030-01-01T00:00:00.000Z';
        const d = deps(rows);
        d.calls.rowCount = rows.length;
        d.queryCompiler.compileRecordList = (meta, opts, filter) => {
            d.calls.queries.push({ opts, filter });
            return { sql: 'x', params: [], primaryField: 'name', limit: 100_000 };
        };
        const [first] = await adapter.enumerate(source(), ctx(), d);
        assert.strictEqual(first.sourceModifiedAt, '2030-01-01T00:00:00.000Z');
    });
}

test('"live" is the default, because a table is already kept current', () => {
    assert.strictEqual(adapter.defaultMode, 'live');
    assert.ok(adapter.supportsModes.includes('live'));
    assert.ok(adapter.supportsModes.includes('manual'));
});

test('it is registered, or the engine stands down on every refresh', () => {
    assert.ok(require('./index').supportedKinds().includes('datatable'));
});

test('the grouping threshold is reachable — the read cap is not the same number', () => {
    // It was: MAX_ROWS and CHUNK_ABOVE_ROWS were both 5000, so `rows.length >
    // CHUNK_ABOVE_ROWS` could never be true and the whole grouped branch was
    // dead code. Deciding from the TABLE's row count instead is what makes it
    // reachable, and the grouped read cap is what makes a big table worth
    // reading at all.
    assert.ok(adapter.MAX_ROWS_GROUPED > adapter.CHUNK_ABOVE_ROWS);
});

test('a table just under the threshold stays one document per row', async () => {
    const d = deps([row(1)]);
    d.calls.rowCount = adapter.CHUNK_ABOVE_ROWS;
    const [item] = await adapter.enumerate(source(), ctx(), d);
    assert.match(item.externalId, /^row:/);
});

// ── Row ordinals ────────────────────────────────────────────────────

describe_row_ordinals();
function describe_row_ordinals() {
    /** A table big enough to be grouped, with the compiler reading it in one page. */
    function bigTable() {
        const rows = Array.from({ length: adapter.CHUNK_ABOVE_ROWS + 10 }, (_, i) => row(i));
        const d = deps(rows);
        d.calls.rowCount = rows.length;
        d.queryCompiler.compileRecordList = (meta, opts, filter) => {
            d.calls.queries.push({ opts, filter });
            return { sql: 'x', params: [], primaryField: 'name', limit: 100_000 };
        };
        return { rows, d };
    }

    test('a block carries the rows it covers as NUMBERS, matching its own title', async () => {
        // The title has always said "Products 1–50" and the externalId
        // "rows:0-49" — 1-based and 0-based, one character apart. Parsing
        // either back out of a string is how a citation ends up off by one, so
        // the citation gets the same two numbers the title was built from.
        const { d } = bigTable();
        const [first] = await adapter.enumerate(source(), ctx(), d);
        assert.strictEqual(first.rowStart, 1);
        assert.strictEqual(first.rowEnd, first.rows.length);
        assert.ok(first.title.endsWith(`${first.rowStart}–${first.rowEnd}`), first.title);
    });

    test('the range survives into the document metadata, which is all that is stored', async () => {
        const { d } = bigTable();
        const [first] = await adapter.enumerate(source(), ctx(), d);
        const doc = await adapter.fetch(first);
        assert.strictEqual(doc.metadata.rowStart, 1);
        assert.strictEqual(doc.metadata.rowEnd, first.rows.length);
        assert.ok(doc.metadata.rowIds.length > 1, 'and does not displace what was already there');
    });

    test('every block after the first counts on from the one before', async () => {
        const { d } = bigTable();
        const items = await adapter.enumerate(source(), ctx(), d);
        assert.ok(items.length > 1);
        for (let i = 1; i < items.length; i++) {
            assert.strictEqual(items[i].rowStart, items[i - 1].rowEnd + 1, `block ${i}`);
        }
    });

    test('one row per document carries NO ordinal, and cites by its own name', async () => {
        // "row 37" is a position in THIS read: one insert at the top makes it
        // wrong, and a number that is wrong by tomorrow is worse than none.
        const d = deps([row(1)]);
        const [item] = await adapter.enumerate(source(), ctx(), d);
        assert.strictEqual(item.rowStart, undefined);
        const doc = await adapter.fetch(item);
        assert.strictEqual(doc.metadata.rowStart, undefined);
        assert.strictEqual(doc.title, 'Product 1');
    });
}

// ── Relations ───────────────────────────────────────────────────────

/**
 * An Orders table whose `supplier` column points at a Suppliers table. The
 * compiler and the store are recorded, as above; the label lookup is told
 * apart from the row read by the filter the compiler was handed.
 */
const ORDERS = {
    key: 'orders',
    fields: [
        { key: 'number', type: 'text' },
        { key: 'supplier', type: 'relation', relation: { table: 'dt_sup' } },
        { key: 'amount', type: 'number' },
    ],
};
const SUPPLIERS = {
    key: 'suppliers',
    fields: [
        { key: 'code', type: 'number' },
        { key: 'name', type: 'text' },
        { key: 'city', type: 'text' },
    ],
};

function order(i, over = {}) {
    return {
        id: `o${i}`, number: `2026-0${i}`, supplier: 's1', amount: 100 * i,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-07-20T10:00:00.000Z',
        ...over,
    };
}

function relDeps(rows, suppliers, calls = {}) {
    calls.access = calls.access || [];
    calls.queries = calls.queries || [];
    calls.resolve = calls.resolve || [];
    calls.versions = calls.versions || [];
    let served = 0;
    return {
        calls,
        datatableResolve: {
            resolveDatatableForStep: async (id, ctx, opts) => {
                calls.resolve.push({ id, ctx, opts });
                if (id === 'dt_sup' && calls.supplierThrows) throw new Error(calls.supplierThrows);
                if (id === 'dt_sup') return { table: { id, name: 'Suppliers', rowCount: suppliers.length }, tableMeta: SUPPLIERS, grade: 'viewer', scopeKey: 'org_1' };
                return { table: { id, name: 'Orders', rowCount: calls.rowCount ?? rows.length }, tableMeta: ORDERS, grade: 'viewer', scopeKey: 'org_1' };
            },
        },
        accessFilter: {
            compileAccessFilter: (meta, grade, viewer, action) => {
                calls.access.push({ table: meta.key, grade, viewer, action });
                return { sql: 'owner_id = ?', params: ['owner1'] };
            },
        },
        queryCompiler: {
            compileRecordList: (meta, opts, filter) => {
                calls.queries.push({ table: meta.key, opts, filter });
                const ids = (opts.filters || []).find(f => f.field === 'id' && f.op === 'in');
                return { sql: ids ? 'LABELS' : 'ROWS', params: ids ? ids.value : [], primaryField: 'number', limit: opts.limit };
            },
            encodeCursor: (v, i) => `${v}|${i}`,
        },
        datatableDbStore: {
            query: async (a, b, sql, params) => {
                if (sql === 'LABELS') return { rows: suppliers.filter(s => params.includes(s.id)) };
                const limit = calls.queries.at(-1).opts.limit;
                const page = rows.slice(served, served + limit + 1);
                served += Math.min(limit, page.length);
                return { rows: page };
            },
        },
        datatableStore: {
            getDataVersion: async (id) => { calls.versions.push(id); return id === 'dt_sup' ? 7 : null; },
        },
    };
}

const vanDijk = { id: 's1', code: 12, name: 'Van Dijk', city: 'Utrecht' };

test('a relation cell is rendered as the row it points at, not as its id', async () => {
    // "supplier: 7f3a…" retrieves for nothing; "supplier: Van Dijk" retrieves
    // for the question that names the supplier, which is the question asked.
    const d = relDeps([order(1)], [vanDijk]);
    const [item] = await adapter.enumerate(source(), ctx(), d);
    const doc = await adapter.fetch(item);
    assert.strictEqual(doc.content, 'number: 2026-01\nsupplier: Van Dijk\namount: 100');
});

test('the label is the target`s first TEXT column, not its first column', async () => {
    // Suppliers' first column is a number nobody would call the supplier by.
    const d = relDeps([order(1)], [vanDijk]);
    const [item] = await adapter.enumerate(source(), ctx(), d);
    assert.doesNotMatch((await adapter.fetch(item)).content, /supplier: 12/);
    assert.strictEqual(adapter.labelFieldFor(SUPPLIERS), 'name');
    assert.strictEqual(adapter.labelFieldFor({ fields: [{ key: 'id' }, { key: 'n', type: 'number' }] }), 'n', 'else the first declared one');
    assert.strictEqual(adapter.labelFieldFor({ fields: [] }), null);
});

test('the target table is read as the OWNER, through ITS OWN access filter', async () => {
    // A supplier the owner may not read is a supplier whose name must not
    // appear in the orders, however many orders point at it.
    const d = relDeps([order(1)], [vanDijk]);
    await adapter.enumerate(source(), ctx(), d);
    const target = d.calls.resolve.find(r => r.id === 'dt_sup');
    assert.ok(target, 'the target was resolved');
    assert.strictEqual(target.ctx.userId, 'owner1');
    assert.strictEqual(target.opts.needed, 'viewer');
    assert.deepStrictEqual(d.calls.access.map(a => a.table), ['orders', 'suppliers'], 'both filters compiled');
    const labels = d.calls.queries.find(q => q.table === 'suppliers');
    assert.ok(labels.filter, 'and the target filter handed to the label query');
});

test('labels are fetched once per target, in batches of ids — not once per row', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => order(i + 1));
    const d = relDeps(rows, [vanDijk]);
    await adapter.enumerate(source(), ctx(), d);
    const labelQueries = d.calls.queries.filter(q => q.table === 'suppliers');
    assert.strictEqual(labelQueries.length, 1, 'five orders, one supplier lookup');
    assert.deepStrictEqual(labelQueries[0].opts.filters, [{ field: 'id', op: 'in', value: ['s1'] }]);
    assert.ok(adapter.LABEL_BATCH <= 200, 'a batch never exceeds what the compiler`s `in` takes');
});

test('the ids ride in the metadata, because that is what the hop joins on', async () => {
    const d = relDeps([order(1)], [vanDijk]);
    const [item] = await adapter.enumerate(source(), ctx(), d);
    const doc = await adapter.fetch(item);
    assert.strictEqual(doc.metadata.datatableId, 'dt1');
    assert.strictEqual(doc.metadata.tableName, 'Orders');
    assert.deepStrictEqual(doc.metadata.relations, [{ column: 'supplier', table: 'dt_sup', rowId: 's1', label: 'Van Dijk' }]);
    assert.match(doc.metadata.relSig, /^[0-9a-f]{16}$/);
});

test('a target row nobody can name leaves the line out — never the id', async () => {
    // The supplier row is gone (erased, or hidden by its own row rules).
    const d = relDeps([order(1)], []);
    const [item] = await adapter.enumerate(source(), ctx(), d);
    const doc = await adapter.fetch(item);
    assert.strictEqual(doc.content, 'number: 2026-01\namount: 100');
    assert.deepStrictEqual(doc.metadata.relations, [{ column: 'supplier', table: 'dt_sup', rowId: 's1', label: null }], 'the id is still known to the hop');
});

test('a target the owner cannot read blanks the column and does NOT fail the pass', async () => {
    // The rows are still worth having without the name.
    const d = relDeps([order(1)], [vanDijk]);
    d.calls.supplierThrows = 'datatable_not_found';
    const [item] = await adapter.enumerate(source(), ctx(), d);
    const doc = await adapter.fetch(item);
    assert.strictEqual(doc.content, 'number: 2026-01\namount: 100');
});

test('a supplier renamed in ITS table changes the order document, though the order never moved', async () => {
    // The row timestamp cannot see it; the label signature can.
    const before = relDeps([order(1)], [vanDijk]);
    const [was] = await adapter.enumerate(source(), ctx(), before);
    const stored = { source_modified_at: was.sourceModifiedAt, metadata: (await adapter.fetch(was)).metadata };
    assert.strictEqual(adapter.isUnchanged(was, stored), true, 'nothing moved: unchanged');

    const after = relDeps([order(1)], [{ ...vanDijk, name: 'Van Dijk & Zn' }]);
    const [now] = await adapter.enumerate(source(), ctx(), after);
    assert.strictEqual(now.sourceModifiedAt, was.sourceModifiedAt, 'the order row itself is untouched');
    assert.strictEqual(adapter.isUnchanged(now, stored), false, 'and still the document is rebuilt');

    // The metadata may arrive as a string from a driver; same answer.
    assert.strictEqual(adapter.isUnchanged(was, { ...stored, metadata: JSON.stringify(stored.metadata) }), true);
});

test('the pass reports the target tables it read, and the version each was at', async () => {
    // What the engine records on the source, so a `live` source is armed when
    // a TARGET changes — which its own rows' timestamps would never show.
    const d = relDeps([order(1)], [vanDijk]);
    const c = ctx();
    await adapter.enumerate(source(), c, d);
    assert.deepStrictEqual(c.relatedTables, { dt_sup: 7 });
    assert.deepStrictEqual(d.calls.versions, ['dt_sup']);
    // Read AFTER the labels: a rename that lands mid-pass belongs to the next
    // version, which the backstop will then see.
    const lastLabelQuery = d.calls.queries.findIndex(q => q.table === 'suppliers');
    assert.ok(lastLabelQuery >= 0);
});

test('a table without relation columns reports nothing new, and its documents read as they did', async () => {
    const d = deps([row(1)]);
    const c = ctx();
    const [item] = await adapter.enumerate(source(), c, d);
    assert.deepStrictEqual(c.relatedTables, {});
    assert.strictEqual(item.relSig, null);
    const doc = await adapter.fetch(item);
    assert.strictEqual(doc.content, 'name: Product 1\nprice: 11');
    assert.strictEqual(doc.metadata.relations, undefined);
    assert.strictEqual(doc.metadata.relSig, undefined);
    assert.strictEqual(doc.metadata.datatableId, 'dt1');
});

test('a relation cell holding several ids reads as all of their names', () => {
    const labels = new Map([['dt_sup', new Map([['s1', 'Van Dijk'], ['s2', 'Jansen']])]]);
    const relations = [{ column: 'supplier', table: 'dt_sup' }];
    assert.strictEqual(adapter.renderRow({ supplier: ['s1', 's2', 's9'] }, ['supplier'], { relations, labels }), 'supplier: Van Dijk, Jansen');
    assert.strictEqual(adapter.renderRow({ supplier: 's9' }, ['supplier'], { relations, labels }), '');
    assert.deepStrictEqual(adapter.cellIds([{ id: 's1' }, '', null, 's2']), ['s1', 's2']);
});

test('the signature is stable across order and blind to nothing that renders', () => {
    const a = [{ column: 'a', table: 't', rowId: '1', label: 'X' }, { column: 'b', table: 't', rowId: '2', label: 'Y' }];
    const b = [a[1], a[0]];
    assert.strictEqual(adapter.relationSignature(a), adapter.relationSignature(b));
    assert.notStrictEqual(adapter.relationSignature(a), adapter.relationSignature([{ ...a[0], label: 'Z' }, a[1]]));
    assert.notStrictEqual(adapter.relationSignature(a), adapter.relationSignature([{ ...a[0], label: null }, a[1]]));
    assert.strictEqual(adapter.relationSignature([]), null);
});

test('a block of rows carries every row`s relations, each saying which row it is from', async () => {
    const rows = Array.from({ length: adapter.CHUNK_ABOVE_ROWS + 10 }, (_, i) => order(i));
    const d = relDeps(rows, [vanDijk]);
    d.calls.rowCount = rows.length;
    d.queryCompiler.compileRecordList = (meta, opts, filter) => {
        d.calls.queries.push({ table: meta.key, opts, filter });
        const ids = (opts.filters || []).find(f => f.field === 'id' && f.op === 'in');
        return { sql: ids ? 'LABELS' : 'ROWS', params: ids ? ids.value : [], primaryField: 'number', limit: ids ? opts.limit : 100_000 };
    };
    const [first] = await adapter.enumerate(source(), ctx(), d);
    const doc = await adapter.fetch(first);
    assert.strictEqual(doc.metadata.relations.length, first.rows.length);
    assert.deepStrictEqual(doc.metadata.relations[0], { column: 'supplier', table: 'dt_sup', rowId: 's1', label: 'Van Dijk', from: 'o0' });
    assert.ok(doc.metadata.relations.length <= adapter.MAX_RELATIONS_PER_DOC);
    assert.match(doc.content, /supplier: Van Dijk/);
});

test('a row is its id, never its text — the duplicate filter is off for this source', () => {
    assert.strictEqual(adapter.dedupe, false);
});

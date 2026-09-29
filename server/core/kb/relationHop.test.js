/**
 * One exact hop along datatable relations, at query time.
 *
 * ── THE TWO PROPERTIES THAT CARRY IT ────────────────────────────────
 * The linked rows are folded INTO the hit's passage, never added as passages
 * of their own: everything downstream ranks and trims passages, and a row with
 * no score would be the first thing thrown away. And the reverse side is
 * bounded on the database — ordered and LIMITed there — because a supplier can
 * have fifty thousand orders and the hop still has to run on every search.
 *
 * Run: cd server && node --test --test-force-exit core/kb/relationHop.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const hop = require('./relationHop');

const KB = ['11111111-1111-1111-1111-111111111111'];

/**
 * A base with a Suppliers table (one row, Van Dijk) and an Orders table
 * (three orders pointing at Van Dijk), as the datatable source stores them.
 */
function fixture(over = {}) {
    const supplierDoc = {
        id: 'doc-sup', title: 'Van Dijk', tenant_id: 'owner1', kb_id: KB[0], table_name: 'Suppliers',
        meta: { datatableId: 'dt_sup', tableName: 'Suppliers', rowIds: ['s1'], relations: [] },
        chunks: [{ id: 901, content: 'name: Van Dijk\ncity: Utrecht', chunk_id: 0 }],
    };
    const orderDocs = [1, 2, 3].map(i => ({
        id: `doc-o${i}`, title: `Order ${i}`, tenant_id: 'owner1', kb_id: KB[0], table_name: 'Orders',
        meta: {
            datatableId: 'dt_ord', tableName: 'Orders', rowIds: [`o${i}`],
            relations: [{ column: 'supplier', table: 'dt_sup', rowId: 's1', label: 'Van Dijk' }],
        },
        chunks: [{ id: 800 + i, content: `number: 2026-0${i}\nsupplier: Van Dijk\namount: ${i}00`, chunk_id: 0 }],
    }));
    const docs = [supplierDoc, ...orderDocs, ...(over.extraDocs || [])];
    const sqls = [];

    const client = {
        released: 0,
        release() { this.released += 1; },
        async query(sql, params) {
            sqls.push({ sql, params });
            if (over.throwOn && sql.includes(over.throwOn)) throw new Error(`boom on ${over.throwOn}`);
            const contains = (m, needle) => {
                // A tiny `@>` for the shapes the hop uses.
                if (needle.datatableId) {
                    return m.datatableId === needle.datatableId
                        && needle.rowIds.every(id => (m.rowIds || []).includes(id));
                }
                if (needle.relations) {
                    return needle.relations.every(n => (m.relations || []).some(r => r.table === n.table && r.rowId === n.rowId));
                }
                return false;
            };
            if (sql.includes('jsonb_array_elements')) {
                const needle = JSON.parse(params[1]);
                const entry = JSON.parse(params[2]);
                const byTable = new Map();
                for (const d of docs) {
                    if (!contains(d.meta, needle)) continue;
                    for (const r of d.meta.relations || []) {
                        if (r.table !== entry.table || r.rowId !== entry.rowId) continue;
                        byTable.set(d.table_name, (byTable.get(d.table_name) || 0) + 1);
                    }
                }
                return { rows: [...byTable].map(([table_name, n]) => ({ table_name, n })) };
            }
            if (sql.includes('JOIN kb_chunks c')) {
                const needle = JSON.parse(params[1]);
                const limit = params[2];
                const rows = [];
                for (const d of docs) {
                    if (!contains(d.meta, needle)) continue;
                    for (const c of d.chunks) rows.push({ id: c.id, content: c.content, chunk_id: c.chunk_id, title: d.title, table_name: d.table_name });
                }
                return { rows: rows.slice(0, limit) };
            }
            if (sql.includes('FROM documents d')) {
                const needle = JSON.parse(params[1]);
                const d = docs.find(x => contains(x.meta, needle));
                return { rows: d ? [{ id: d.id, title: d.title, tenant_id: d.tenant_id, kb_id: d.kb_id, table_name: d.table_name }] : [] };
            }
            if (sql.includes('FROM kb_chunks')) {
                const d = docs.find(x => x.id === params[2]);
                return { rows: d ? d.chunks.slice(0, params[3]) : [] };
            }
            throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
        },
    };
    let acquired = 0;
    const getClient = async () => { acquired += 1; return client; };
    return { docs, client, sqls, getClient, acquired: () => acquired };
}

/** A retrieval row as `enrichWithDocumentFacts` leaves it. */
function hit(doc, over = {}) {
    const row = {
        id: doc.chunks[0].id, content: doc.chunks[0].content, title: doc.title,
        document_id: doc.id, score: 0.9, ...over,
    };
    Object.defineProperty(row, 'doc_meta', { value: doc.meta, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(row, 'doc_kind', { value: 'datatable', enumerable: false, writable: true, configurable: true });
    return row;
}

const quiet = { log: () => {} };

// ── Reverse: a hit on the supplier pulls in its orders ──────────────

test('a hit on a supplier pulls in the orders pointing at it, and says how many', async () => {
    const f = fixture();
    const results = [hit(f.docs[0])];
    const stats = await hop.expandRelations(results, { kbIds: KB, query: 'wat bestelden we bij Van Dijk', getClient: f.getClient, ...quiet });

    assert.strictEqual(stats.anchors, 1);
    assert.match(results[0].content, /\[Linked rows\]/);
    assert.match(results[0].content, /Orders: 3/, 'the count, always');
    assert.match(results[0].content, /Order 1: number: 2026-01 \| supplier: Van Dijk \| amount: 100/, 'a row on one line');
    assert.deepStrictEqual(results[0].linked, [{ kind: 'rows', table: 'Orders', count: 3, shown: 3 }]);
    assert.strictEqual(f.client.released, 1, 'the connection goes back');
});

test('the reverse side is ranked and LIMITed on the database, by vector when there is one', async () => {
    // A supplier with fifty thousand orders is one indexed query, not fifty
    // thousand rows in Node.
    const f = fixture();
    await hop.expandRelations([hit(f.docs[0])], { kbIds: KB, query: 'x', vectorStr: '[0.1,0.2]', getClient: f.getClient, limits: { reversePerAnchor: 2 }, ...quiet });
    const rev = f.sqls.find(s => s.sql.includes('JOIN kb_chunks c'));
    assert.ok(rev, 'the reverse query ran');
    assert.match(rev.sql, /ORDER BY c\.embedding <=> \$4::vector/, 'ordered by distance to the question');
    assert.match(rev.sql, /LIMIT \$3/);
    assert.strictEqual(rev.params[2], 2, 'and cut to the per-anchor limit there');
    assert.match(rev.sql, /d\.metadata @> \$2::jsonb/, 'found by containment, which the GIN index answers');
});

test('without a query vector the reverse side ranks by text, never by nothing', async () => {
    const f = fixture();
    await hop.expandRelations([hit(f.docs[0])], { kbIds: KB, query: 'openstaand', getClient: f.getClient, ...quiet });
    const rev = f.sqls.find(s => s.sql.includes('JOIN kb_chunks c'));
    assert.match(rev.sql, /ts_rank_cd\(c\.tsv, websearch_to_tsquery\('simple', \$4\)\)/);
    assert.strictEqual(rev.params[3], 'openstaand');
});

// ── Forward: a hit on an order pulls in its supplier ────────────────

test('a hit on an order pulls in the supplier it points at, named by its column', async () => {
    const f = fixture();
    const results = [hit(f.docs[1])];
    await hop.expandRelations(results, { kbIds: KB, query: 'x', getClient: f.getClient, ...quiet });

    assert.match(results[0].content, /supplier → Suppliers: Van Dijk\nname: Van Dijk \| city: Utrecht/);
    assert.deepStrictEqual(results[0].linked, [
        { kind: 'row', column: 'supplier', table: 'Suppliers', title: 'Van Dijk' },
        // An order is pointed at by nothing; no count line, no entry.
    ]);
    assert.doesNotMatch(results[0].content, /Rows pointing at this one/);
});

test('the target row is found by ITS table and row id, in the searched bases only', async () => {
    const f = fixture();
    await hop.expandRelations([hit(f.docs[1])], { kbIds: KB, query: 'x', getClient: f.getClient, ...quiet });
    const fwd = f.sqls.find(s => s.sql.includes('FROM documents d') && s.sql.includes('LIMIT 1'));
    assert.ok(fwd);
    assert.deepStrictEqual(fwd.params[0], KB, 'scoped to the bases being searched');
    assert.deepStrictEqual(JSON.parse(fwd.params[1]), { datatableId: 'dt_sup', rowIds: ['s1'] });
});

test('it reads documents in the base, never the tables themselves', async () => {
    // A table merely pointed at is not one its owner chose to expose here.
    // Attaching it is how a person says the join is wanted. The fixture's
    // client throws `unexpected sql` for anything outside the four shapes a
    // documents/kb_chunks hop needs (see `fixture()` above), so a hop that
    // reached into a table's actual rows — through a store with its own
    // pool, not just through `getClient` — would surface here as a rejected
    // call, not as a passing test that happened not to look.
    const f = fixture();
    // Both directions in one run: docs[0] (a supplier) hops in reverse to its
    // orders, docs[1] (an order) hops forward to its supplier.
    const results = [hit(f.docs[0]), hit(f.docs[1])];
    const stats = await hop.expandRelations(results, { kbIds: KB, query: 'x', getClient: f.getClient, ...quiet });

    assert.ok(stats.forward + stats.reverse > 0, 'at least one hop actually ran');
    assert.ok(f.sqls.length > 0, 'and it queried the database to do it');
    for (const { sql } of f.sqls) {
        assert.match(sql, /FROM documents d|FROM kb_chunks|JOIN kb_chunks c|jsonb_array_elements/,
            `touched something other than documents/kb_chunks: ${sql.slice(0, 80)}`);
    }
});

// ── What is left alone ──────────────────────────────────────────────

test('a passage that is not a table row is left untouched, and no connection is taken', async () => {
    const f = fixture();
    const results = [{ id: 1, content: 'Artikel 4. Verlof …', title: 'Handboek', document_id: 'doc-x' }];
    const stats = await hop.expandRelations(results, { kbIds: KB, query: 'x', getClient: f.getClient, ...quiet });
    assert.deepStrictEqual(stats, { anchors: 0, forward: 0, reverse: 0 });
    assert.strictEqual(results[0].content, 'Artikel 4. Verlof …');
    assert.strictEqual(f.acquired(), 0);
    assert.strictEqual(results[0].linked, undefined);
});

test('a block of rows is not an anchor', () => {
    // Fifty rows point fifty ways; "the rows pointing at this" has no this.
    const row = hit(fixture().docs[0]);
    row.doc_meta = { ...row.doc_meta, rowIds: ['s1', 's2'] };
    assert.strictEqual(hop.isAnchor(row), false);
    row.doc_meta = { ...row.doc_meta, rowIds: ['s1'] };
    assert.strictEqual(hop.isAnchor(row), true);
    row.doc_kind = 'upload';
    assert.strictEqual(hop.isAnchor(row), false);
});

test('a linked row that is already a passage of its own is counted, not repeated', async () => {
    // Repeating it would make the two passages read as one to the
    // near-duplicate filter downstream, and the model already has it.
    const f = fixture();
    const results = [hit(f.docs[0]), hit(f.docs[1])];
    await hop.expandRelations(results, { kbIds: KB, query: 'x', getClient: f.getClient, ...quiet });
    const supplier = results[0];
    assert.match(supplier.content, /Orders: 3/);
    assert.doesNotMatch(supplier.content, /Order 1:/, 'order 1 is its own passage');
    assert.match(supplier.content, /Order 2:/);
    assert.deepStrictEqual(supplier.linked, [{ kind: 'rows', table: 'Orders', count: 3, shown: 2 }]);
    const order = results[1];
    assert.doesNotMatch(order.content, /name: Van Dijk \| city/, 'the supplier is its own passage too');
    assert.deepStrictEqual(order.linked, [{ kind: 'row', column: 'supplier', table: 'Suppliers', title: 'Van Dijk' }]);
});

test('only the first few hits are expanded', async () => {
    const f = fixture();
    const results = [hit(f.docs[1]), hit(f.docs[2]), hit(f.docs[3])];
    const stats = await hop.expandRelations(results, { kbIds: KB, query: 'x', getClient: f.getClient, limits: { anchors: 2 }, ...quiet });
    assert.strictEqual(stats.anchors, 2);
    assert.match(results[0].content, /\[Linked rows\]/);
    assert.match(results[1].content, /\[Linked rows\]/);
    assert.doesNotMatch(results[2].content, /\[Linked rows\]/);
});

test('the linked block is capped, so one hop cannot eat the passage budget', async () => {
    const f = fixture();
    const results = [hit(f.docs[0])];
    await hop.expandRelations(results, { kbIds: KB, query: 'x', getClient: f.getClient, limits: { maxLinkedChars: 80 }, ...quiet });
    const block = results[0].content.split('\n\n[Linked rows]')[1] || '';
    assert.ok(block.length <= 80 - '[Linked rows]'.length + 1, `block is ${block.length} chars`);
});

// ── Failure ─────────────────────────────────────────────────────────

test('a hop that fails leaves the passage as it was, and never throws into the search', async () => {
    const f = fixture({ throwOn: 'jsonb_array_elements' });
    const results = [hit(f.docs[0])];
    const before = results[0].content;
    await assert.doesNotReject(() => hop.expandRelations(results, { kbIds: KB, query: 'x', getClient: f.getClient, ...quiet }));
    assert.strictEqual(results[0].content, before);
    assert.strictEqual(results[0].linked, undefined);
    assert.strictEqual(f.client.released, 1, 'and the connection still goes back');
});

test('no bases, no rows, no work', async () => {
    const f = fixture();
    assert.deepStrictEqual(await hop.expandRelations([], { kbIds: KB, getClient: f.getClient, ...quiet }), { anchors: 0, forward: 0, reverse: 0 });
    assert.deepStrictEqual(await hop.expandRelations([hit(f.docs[0])], { kbIds: [], getClient: f.getClient, ...quiet }), { anchors: 0, forward: 0, reverse: 0 });
    assert.strictEqual(f.acquired(), 0);
});

// ── Blocks of rows on the far side ──────────────────────────────────

test('in a block of rows, the row that names the anchor is the one shown', () => {
    const block = 'number: 1\nsupplier: Jansen\n\nnumber: 2\nsupplier: Van Dijk\n\nnumber: 3\nsupplier: Bakker';
    assert.strictEqual(hop.pickRowBlock(block, 'Van Dijk'), 'number: 2\nsupplier: Van Dijk');
    assert.strictEqual(hop.pickRowBlock(block, 'Nobody'), 'number: 1\nsupplier: Jansen', 'else the first');
    assert.strictEqual(hop.pickRowBlock('', 'x'), '');
});

test('of a document`s chunks, the one that mentions the label is the one read', () => {
    const chunks = [{ id: 1, content: 'a: 1' }, { id: 2, content: 'name: Van Dijk' }];
    assert.strictEqual(hop.pickChunk(chunks, 'van dijk').id, 2);
    assert.strictEqual(hop.pickChunk(chunks, null).id, 1);
    assert.strictEqual(hop.pickChunk([], 'x'), null);
});

test('a row reads as one line, clipped', () => {
    assert.strictEqual(hop.compactRow('a: 1\n\nb: 2\n', 100), 'a: 1 | b: 2');
    assert.strictEqual(hop.compactRow('abcdefghij', 5), 'abcd…');
});

test('the relation targets of a document are distinct and capped', () => {
    const meta = { relations: [
        { column: 'supplier', table: 't', rowId: '1', label: 'A' },
        { column: 'supplier', table: 't', rowId: '1', label: 'A' },
        { column: 'buyer', table: 'u', rowId: '2' },
        { column: 'x', table: 'v', rowId: '3' },
        { bad: true },
    ] };
    const t = hop.forwardTargets(meta, 2);
    assert.deepStrictEqual(t, [
        { column: 'supplier', table: 't', rowId: '1', label: 'A' },
        { column: 'buyer', table: 'u', rowId: '2', label: null },
    ]);
    assert.deepStrictEqual(hop.forwardTargets({}, 3), []);
});

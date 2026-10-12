/**
 * "What breaks if I delete this?"
 *
 * The answer feeds a delete confirmation, so the failure that matters is the
 * one where NOT KNOWING is reported as NOTHING. A missing consumer table, a
 * query that errored — either would otherwise make the dialog say "nothing
 * depends on this" about a knowledge base three agents are using, and the
 * person would believe it, because they asked.
 *
 * Run: node --test --test-force-exit core/kb/kbUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { usageForKb, usageSummary, scrubReferences, KINDS, SCANS } = require('./kbUsage');

/**
 * A fake pg client. `tables` names what exists; `rowsFor` answers a scan.
 * Anything not named is absent, which is the case worth exercising.
 */
function db({ tables = KINDS.map(k => SCANS[k].table), rowsFor = () => [], failOn = [] } = {}) {
    const queries = [];
    return {
        queries,
        query: async (sql, params) => {
            if (/to_regclass/.test(sql)) {
                return { rows: [{ t: tables.includes(params[0]) ? params[0] : null }] };
            }
            queries.push({ sql, params });
            const kind = KINDS.find(k => SCANS[k].sql === sql);
            if (failOn.includes(kind)) throw new Error(`${kind} is down`);
            return { rows: rowsFor(kind, params) || [] };
        },
    };
}

test('finds every kind of consumer, with the Used-by row shape', async () => {
    const d = db({
        rowsFor: (kind) => (kind === 'agent'
            ? [{ id: 'ag1', title: 'Support assistant', owner_id: 'u1', last_at: '2026-09-01T00:00:00Z' }]
            : []),
    });
    const { rows, partial } = await usageForKb('kb1', { db: d });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows, [{
        kind: 'agent', id: 'ag1', title: 'Support assistant',
        role: 'chat', ownerId: 'u1', lastAt: '2026-09-01T00:00:00Z',
    }]);
});

test('a consumer table that does not exist is PARTIAL, never zero', async () => {
    // "The apps table is not on this install" is not the same statement as
    // "no app uses this", and only one of them is safe to delete on.
    const d = db({ tables: ['agents'] });
    const { rows, partial } = await usageForKb('kb1', { db: d });
    assert.deepStrictEqual(rows, []);
    assert.ok(partial.includes('app'));
    assert.ok(!partial.includes('agent'));
});

test('a query that fails is PARTIAL too, and does not abandon the rest', async () => {
    const d = db({
        failOn: ['automation'],
        rowsFor: (kind) => (kind === 'agent' ? [{ id: 'ag1', title: 'A' }] : []),
    });
    const { rows, partial } = await usageForKb('kb1', { db: d });
    assert.deepStrictEqual(partial, ['automation']);
    assert.strictEqual(rows.length, 1, 'the other seven kinds were still asked');
});

test('the id is passed to jsonpath as a VARIABLE, never concatenated into it', async () => {
    // A kb id is a route parameter. Concatenated, a value carrying a quote
    // would close the string literal inside the jsonpath and be parsed as
    // path syntax — an injection into the path, placeholder or not.
    const d = db();
    await usageForKb('kb"1', { db: d });
    for (const q of d.queries) {
        assert.ok(!q.sql.includes('|| $1 ||'), 'no concatenation into a jsonpath');
        if (/jsonb_path_exists/.test(q.sql)) {
            assert.match(q.sql, /jsonb_build_object\('id', \$1::text\)/);
            assert.deepStrictEqual(q.params, ['kb"1'], 'the raw id, bound');
        }
    }
});

test('an app is found through its PUBLISHED definition, not only its draft', async () => {
    // An app that uses the base only in the version people actually run still
    // breaks when it goes.
    const sql = SCANS.app.sql;
    assert.match(sql, /COALESCE\(definition/);
    assert.match(sql, /COALESCE\(published_definition/);
});

test('no id is no work', async () => {
    const d = db();
    assert.deepStrictEqual(await usageForKb(null, { db: d }), { rows: [], partial: [] });
    assert.deepStrictEqual(await usageForKb('', { db: d }), { rows: [], partial: [] });
    assert.strictEqual(d.queries.length, 0);
});

describe_summary();
function describe_summary() {
    test('counts per kind, per knowledge base', async () => {
        const d = db({
            rowsFor: (kind, params) => {
                const id = params[0].startsWith('[') ? JSON.parse(params[0])[0] : params[0];
                if (id === 'kb1' && kind === 'agent') return [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
                if (id === 'kb1' && kind === 'webpage') return [{ id: 'w' }];
                return [];
            },
        });
        const out = await usageSummary(['kb1', 'kb2'], { db: d });
        assert.deepStrictEqual(out.kb1.counts, { agent: 3, webpage: 1 });
        assert.deepStrictEqual(out.kb2.counts, {}, 'a base nothing uses counts nothing');
    });

    test('a kind with no counts is absent rather than zero', async () => {
        // The overview renders a pill per entry; a zero would draw "0 agents".
        const d = db();
        const out = await usageSummary(['kb1'], { db: d });
        assert.deepStrictEqual(out.kb1.counts, {});
    });

    test('a missing table is partial here too', async () => {
        const d = db({ tables: ['agents'] });
        const out = await usageSummary(['kb1'], { db: d });
        assert.ok(out.kb1.partial.includes('app'));
    });

    test('every requested id gets an entry, even one nothing uses', async () => {
        const d = db();
        const out = await usageSummary(['kb1', 'kb2'], { db: d });
        assert.deepStrictEqual(Object.keys(out).sort(), ['kb1', 'kb2']);
    });

    test('nothing in, nothing asked', async () => {
        const d = db();
        assert.deepStrictEqual(await usageSummary([], { db: d }), {});
        assert.strictEqual(d.queries.length, 0);
    });
}

describe_scrub();
function describe_scrub() {
    function scrubDb({ tables = ['webpages', 'projects', 'notebooks', 'word_templates', 'support_inboxes', 'agents'], fail = [] } = {}) {
        const updates = [];
        return {
            updates,
            query: async (sql, params) => {
                if (/to_regclass/.test(sql)) {
                    return { rows: [{ t: tables.includes(params[0]) ? params[0] : null }] };
                }
                const table = (sql.match(/UPDATE (\w+)/) || [])[1];
                if (fail.includes(table)) throw new Error(`${table} is locked`);
                updates.push({ table, params });
                return { rowCount: 1 };
            },
        };
    }

    test('every array-shaped reference is removed', async () => {
        // Today deleteKB scrubs `projects` alone, so an agent kept a dead id
        // in its config for ever — invisible until somebody opened it and
        // wondered why a knowledge base they could not find was attached.
        const d = scrubDb();
        const out = await scrubReferences('kb1', { db: d });
        const touched = [...new Set(d.updates.map(u => u.table))].sort();
        assert.deepStrictEqual(touched, ['agents', 'notebooks', 'projects', 'support_inboxes', 'webpages', 'word_templates']);
        assert.strictEqual(out.agent, 1);
        assert.strictEqual(out.project, 1);
        // support_inboxes is written twice: the kb_ids array, and the scalar
        // kb_ingest_kb_id an inbox distils into. Both are references.
        assert.strictEqual(d.updates.filter(u => u.table === 'support_inboxes').length, 2);
    });

    test('one consumer failing does not abandon the other seven', async () => {
        // The base is going either way, and a half-scrubbed install is the
        // worst of the three outcomes.
        const d = scrubDb({ fail: ['projects'] });
        const out = await scrubReferences('kb1', { db: d });
        assert.strictEqual(out.project, 0);
        assert.strictEqual(out.webpage, 1, 'the rest still ran');
    });

    test('a table that is not installed is skipped, not an error', async () => {
        const d = scrubDb({ tables: ['agents'] });
        const out = await scrubReferences('kb1', { db: d });
        assert.strictEqual(out.agent, 1);
        assert.strictEqual(out.webpage, 0);
    });

    test('automations and apps are deliberately NOT rewritten', async () => {
        // The id sits at an unknown depth inside a definition that also
        // encodes the shape of a canvas. Rewriting arbitrary JSON in place
        // risks corrupting an automation somebody spent an afternoon building, to
        // save them an error that already names the missing base.
        const d = scrubDb({ tables: ['agents', 'automations', 'studio_apps'] });
        await scrubReferences('kb1', { db: d });
        const touched = d.updates.map(u => u.table);
        assert.ok(!touched.includes('automations'));
        assert.ok(!touched.includes('studio_apps'));
    });

    test('no id is no work', async () => {
        const d = scrubDb();
        await scrubReferences(null, { db: d });
        assert.strictEqual(d.updates.length, 0);
    });
}

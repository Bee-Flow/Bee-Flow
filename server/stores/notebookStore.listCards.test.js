/**
 * notebookStore card-listing + update-side-effect tests.
 *
 * buildListCardsQuery is pure ({sql, params}), so the injection-safety
 * invariants are locked without a database: the projection ships NO document
 * bodies, user search input is ILIKE-escaped and always parameter-bound, and
 * sort/filter come from whitelist maps — never interpolated.
 *
 * _updateNotebook behaviour runs against the same require.cache db mock as
 * notebookStore.mirror.test.js: sanitize-on-write, cached preview/word-count
 * clauses, the pinned non-content clause and the {noop:true} 0-clause shape.
 *
 * Run: node --test stores/notebookStore.listCards.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const state = { rowCount: 1, returnedVersion: 5 };
const calls = [];

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        run: async (sql, params = []) => {
            calls.push({ sql, params });
            if (/^UPDATE notebooks SET/i.test(sql.trim())) {
                return { rowCount: state.rowCount, rows: [{ version: state.returnedVersion }] };
            }
            return { rowCount: 1 };
        },
        getOne: async (sql, params = []) => {
            if (/MAX\(sort_order\)/i.test(sql)) return { next: 0 };
            if (/FROM notebook_sources/i.test(sql)) {
                return { id: params[0], notebook_id: params[1] || 'nb1', type: 'text', name: 'x', status: 'ready' };
            }
            if (/SELECT version FROM notebooks/i.test(sql)) return { version: 7 };
            return null;
        },
        getAll: async () => [],
        exec: async () => undefined,
    },
};

const notebookStore = require('./notebookStore');

function reset() { calls.length = 0; state.rowCount = 1; }

function capturedUpdate() {
    const c = [...calls].reverse().find(x => /^UPDATE notebooks SET/i.test(x.sql.trim()));
    assert.ok(c, 'expected an UPDATE notebooks statement');
    const cols = [...c.sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)].map(m => [m[1], c.params[Number(m[2]) - 1]]);
    return { sql: c.sql, params: c.params, cols: Object.fromEntries(cols) };
}

// ── buildListCardsQuery ───────────────────────────────────────────
test('projection never ships document bodies or private columns', () => {
    const { sql } = notebookStore.buildListCardsQuery('u1', {});
    for (const col of ['document_content', 'document_md', 'settings', 'instructions', 'pii_token_map', 'knowledge_base_ids']) {
        assert.ok(!sql.includes(col), `listing SQL must not reference ${col}`);
    }
    assert.match(sql, /n\.preview/);
    assert.match(sql, /AS message_count/);
});

test('type is always bound as a parameter', () => {
    const def = notebookStore.buildListCardsQuery('u1', {});
    assert.match(def.sql, /n\.type = \$2/);
    assert.strictEqual(def.params[1], 'notebook');
    const other = notebookStore.buildListCardsQuery('u1', { type: 'archive' });
    assert.strictEqual(other.params[1], 'archive');
});

test('search: %, _ and \\ are escaped in the single bound parameter', () => {
    const { sql, params } = notebookStore.buildListCardsQuery('u1', { search: '50%_\\x' });
    assert.strictEqual(params[2], '%50\\%\\_\\\\x%');
    assert.strictEqual((sql.match(/\$3/g) || []).length, 4, 'name/description/document_md/source-name all reuse $3');
    assert.match(sql, /ILIKE \$3 ESCAPE '\\'/);
    assert.ok(!sql.includes('50%'), 'raw search text must not appear in the SQL');
});

test('document_md may be SEARCHED but only via the bound param', () => {
    const { sql } = notebookStore.buildListCardsQuery('u1', { search: 'foo' });
    assert.match(sql, /n\.document_md ILIKE \$3/);
});

test('unknown sort key falls back to activity, never interpolated', () => {
    const { sql } = notebookStore.buildListCardsQuery('u1', { sort: 'name; DROP TABLE notebooks;--' });
    assert.match(sql, /COALESCE\(n\.last_activity_at, n\.updated_at\) DESC/);
    assert.ok(!/DROP/i.test(sql));
});

test('whitelisted sorts map to their expressions', () => {
    assert.match(notebookStore.buildListCardsQuery('u1', { sort: 'name' }).sql, /LOWER\(n\.name\) ASC/);
    assert.match(notebookStore.buildListCardsQuery('u1', { sort: 'created' }).sql, /n\.created_at DESC/);
    assert.match(notebookStore.buildListCardsQuery('u1', { sort: 'words' }).sql, /n\.doc_word_count \+/);
});

test('pinned notebooks always order first', () => {
    const { sql } = notebookStore.buildListCardsQuery('u1', { sort: 'name' });
    assert.match(sql, /ORDER BY n\.pinned_at DESC NULLS LAST,\s*LOWER\(n\.name\) ASC/);
});

test('filter whitelist: pinned applies its predicate, unknown filter is ignored', () => {
    assert.match(notebookStore.buildListCardsQuery('u1', { filter: 'pinned' }).sql, /n\.pinned_at IS NOT NULL/);
    const evil = notebookStore.buildListCardsQuery('u1', { filter: "1=1; DROP TABLE" });
    assert.ok(!/DROP/i.test(evil.sql));
    assert.strictEqual(evil.sql, notebookStore.buildListCardsQuery('u1', {}).sql);
});

test('limit/offset are clamped and bound', () => {
    const { sql, params } = notebookStore.buildListCardsQuery('u1', { limit: 10000, offset: -3 });
    assert.strictEqual(params[params.length - 2], notebookStore.MAX_CARD_LIMIT);
    assert.strictEqual(params[params.length - 1], 0);
    assert.match(sql, /LIMIT \$\d+ OFFSET \$\d+/);
});

test('MAX_CARD_LIMIT is the exported single source of truth for the clamp', () => {
    assert.strictEqual(notebookStore.MAX_CARD_LIMIT, 200);
});

// ── mapNotebookCardRow ────────────────────────────────────────────
test('mapNotebookCardRow exposes card fields only', () => {
    const mapped = notebookStore.mapNotebookCardRow({
        id: 'n1', name: 'N', description: '', type: 'notebook', version: 3,
        preview: 'p', doc_word_count: '12', pinned_at: '2026-08-01T00:00:00Z',
        last_activity_at: null, last_activity_kind: null,
        created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
        source_count: '2', processing_count: '1', failed_count: '0',
        source_word_count: '100', message_count: '4',
    });
    assert.strictEqual(mapped.pinned, true);
    assert.strictEqual(mapped.docWordCount, 12);
    assert.strictEqual(mapped.messageCount, 4);
    assert.ok(!('documentContent' in mapped) && !('documentMd' in mapped) && !('settings' in mapped) && !('instructions' in mapped));
});

// ── _updateNotebook side effects ──────────────────────────────────
test('0-clause update reports {ok:false, conflict:false, noop:true}', async () => {
    reset();
    const r = await notebookStore.updateNotebookCas('nb1', 'u1', {});
    assert.deepStrictEqual(r, { ok: false, conflict: false, noop: true });
    assert.strictEqual(calls.length, 0, 'no SQL for a no-op');
});

test('content write derives preview + doc_word_count and marks edit activity', async () => {
    reset();
    const r = await notebookStore.updateNotebookCas('nb1', 'u1', { documentContent: '<p>Hello world</p><p>Second line</p>' });
    const u = capturedUpdate();
    assert.strictEqual(u.cols.preview, 'Hello world\nSecond line');
    assert.strictEqual(u.cols.doc_word_count, 4);
    assert.match(u.sql, /version = version \+ 1/);
    assert.match(u.sql, /last_activity_at = NOW\(\)/);
    assert.match(u.sql, /last_activity_kind = 'edit'/);
    assert.match(u.sql, /RETURNING version/);
    assert.deepStrictEqual(r, { ok: true, conflict: false, version: 5 });
});

test('markdown body: preview comes from the stripped mirror', async () => {
    reset();
    await notebookStore.updateNotebook('nb1', 'u1', { documentContent: '# Title\n\nHello **world**' });
    const u = capturedUpdate();
    assert.strictEqual(u.cols.preview, 'Title Hello world');
    assert.strictEqual(u.cols.doc_word_count, 3);
});

test('HTML content is sanitized before it reaches the row', async () => {
    reset();
    await notebookStore.updateNotebook('nb1', 'u1', { documentContent: '<p>hi</p><script>alert(1)</script>' });
    const u = capturedUpdate();
    assert.ok(!/script|alert/i.test(u.cols.document_content), 'script must be stripped at the store choke point');
    assert.match(u.cols.document_content, /<p>hi<\/p>/);
});

test('pinned is a non-content clause: no version bump, no activity', async () => {
    reset();
    const r = await notebookStore.updateNotebookCas('nb1', 'u1', { pinned: true });
    const u = capturedUpdate();
    assert.match(u.sql, /pinned_at = NOW\(\)/);
    assert.ok(!/version = version \+ 1/.test(u.sql));
    assert.ok(!/last_activity/.test(u.sql));
    assert.strictEqual(r.ok, true);

    reset();
    await notebookStore.updateNotebookCas('nb1', 'u1', { pinned: false });
    assert.match(capturedUpdate().sql, /pinned_at = NULL/);
});

test('pin-only write does NOT bump updated_at (pinning is not recency)', async () => {
    reset();
    await notebookStore.updateNotebookCas('nb1', 'u1', { pinned: true });
    let u = capturedUpdate();
    assert.match(u.sql, /pinned_at = NOW\(\)/);
    assert.ok(!/updated_at = NOW\(\)/.test(u.sql), 'legacy rows fall back to updated_at for recency — a pin must not read as "just now"');

    reset();
    await notebookStore.updateNotebookCas('nb1', 'u1', { pinned: false });
    assert.ok(!/updated_at = NOW\(\)/.test(capturedUpdate().sql), 'unpin is pin-only too');
});

test('pinned combined with another field still bumps updated_at', async () => {
    reset();
    await notebookStore.updateNotebookCas('nb1', 'u1', { pinned: true, name: 'Renamed' });
    const u = capturedUpdate();
    assert.match(u.sql, /pinned_at = NOW\(\)/);
    assert.match(u.sql, /updated_at = NOW\(\)/);
});

// ── touchActivity wiring ──────────────────────────────────────────
test('addSource and deleteSource record source activity', async () => {
    reset();
    await notebookStore.addSource({ notebookId: 'nb1', type: 'text', name: 'S' });
    let touch = calls.find(c => /last_activity_kind = \$2/.test(c.sql));
    assert.ok(touch, 'addSource must touch activity');
    assert.deepStrictEqual(touch.params, ['nb1', 'source']);

    reset();
    await notebookStore.deleteSource('s1', 'nb1');
    touch = calls.find(c => /last_activity_kind = \$2/.test(c.sql));
    assert.ok(touch, 'deleteSource must touch activity');
    assert.deepStrictEqual(touch.params, ['nb1', 'source']);
});

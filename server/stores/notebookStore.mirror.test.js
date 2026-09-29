/**
 * notebookStore.updateNotebook — Markdown-mirror + CAS-result regression tests.
 *
 * Two bugs this locks:
 *
 *  1. `document_md` was ALWAYS derived with htmlToMarkdown(documentContent).
 *     When the content is already Markdown (the workspace-notebook and AI tool
 *     paths write Markdown), running an HTML→Markdown pass over it escaped and
 *     flattened the text. The AI tools then PREFER that mirror, so the model
 *     read a corrupted document. Related: the lenient converter returns '' on a
 *     parse failure, which used to be persisted — blanking the mirror.
 *
 *  2. A CAS conflict returned `{ ok: false, conflict: true }` — an OBJECT, which
 *     is truthy — so every `if (!ok)` caller read a REJECTED write as success.
 *
 * Run: node --test stores/notebookStore.mirror.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const state = { rowCount: 1, existsOnReRead: true, lastSql: '', lastParams: [] };
const calls = [];

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        run: async (sql, params = []) => {
            calls.push({ sql, params });
            state.lastSql = sql; state.lastParams = params;
            if (/^UPDATE notebooks/i.test(sql.trim())) return { rowCount: state.rowCount };
            return { rowCount: 1 };
        },
        getOne: async (sql) => {
            if (/SELECT version FROM notebooks/i.test(sql)) return state.existsOnReRead ? { version: 7 } : null;
            return null;
        },
        getAll: async () => [],
        exec: async () => undefined,
    },
};

const notebookStore = require('./notebookStore');

// Pull the `document_md` / `document_format` values out of the recorded UPDATE.
function capturedUpdate() {
    const c = [...calls].reverse().find(x => /^UPDATE notebooks/i.test(x.sql.trim()));
    assert.ok(c, 'expected an UPDATE notebooks statement');
    const cols = [...c.sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)].map(m => [m[1], c.params[Number(m[2]) - 1]]);
    return Object.fromEntries(cols);
}

function reset() { calls.length = 0; state.rowCount = 1; state.existsOnReRead = true; }

// ── 1. Markdown mirror ────────────────────────────────────────────
test('Markdown content is mirrored VERBATIM, not run through htmlToMarkdown', async () => {
    reset();
    const md = '# Heading\n\n- one\n- two\n\n**bold** and _em_\n';
    await notebookStore.updateNotebook('nb1', 'u1', { documentContent: md });
    const u = capturedUpdate();
    assert.strictEqual(u.document_md, md, 'the Markdown mirror must be byte-identical');
    assert.ok(!/\\#/.test(u.document_md), 'no escaped heading marker may appear');
    assert.strictEqual(u.document_format, 'markdown', 'format flag follows the content');
});

test('HTML content still derives a Markdown mirror and is flagged html', async () => {
    reset();
    await notebookStore.updateNotebook('nb1', 'u1', { documentContent: '<h1>Heading</h1><p>text</p>' });
    const u = capturedUpdate();
    assert.ok(typeof u.document_md === 'string' && u.document_md.length > 0, 'a mirror is derived from HTML');
    assert.match(u.document_md, /Heading/);
    assert.strictEqual(u.document_format, 'html');
});

test('an explicit documentMd from the caller always wins', async () => {
    reset();
    await notebookStore.updateNotebook('nb1', 'u1', { documentContent: '<p>x</p>', documentMd: 'CANONICAL' });
    assert.strictEqual(capturedUpdate().document_md, 'CANONICAL');
});

test('emptying a document does not reclassify its format', async () => {
    reset();
    await notebookStore.updateNotebook('nb1', 'u1', { documentContent: '' });
    const u = capturedUpdate();
    assert.strictEqual(u.document_md, '', 'mirror is emptied alongside the content');
    assert.strictEqual(u.document_format, undefined, 'format flag is left alone');
});

test('an explicit documentFormat is respected over the inferred one', async () => {
    reset();
    await notebookStore.updateNotebook('nb1', 'u1', { documentContent: '# md', documentFormat: 'html' });
    assert.strictEqual(capturedUpdate().document_format, 'html');
});

// ── 2. CAS result shape ───────────────────────────────────────────
test('updateNotebook returns a real boolean on success', async () => {
    reset();
    const ok = await notebookStore.updateNotebook('nb1', 'u1', { name: 'x' });
    assert.strictEqual(ok, true, 'must be the boolean true, not an object');
});

test('a CAS conflict is FALSY through updateNotebook (was a truthy object)', async () => {
    reset();
    state.rowCount = 0;            // the UPDATE matched nothing
    state.existsOnReRead = true;   // …but the row is still there ⇒ conflict
    const ok = await notebookStore.updateNotebook('nb1', 'u1', { documentContent: '<p>x</p>', expectedVersion: 3 });
    assert.strictEqual(ok, false, 'a rejected write must be falsy so `if (!ok)` fires');
});

test('updateNotebookCas distinguishes a conflict from a missing notebook', async () => {
    reset();
    state.rowCount = 0; state.existsOnReRead = true;
    const conflict = await notebookStore.updateNotebookCas('nb1', 'u1', { documentContent: '<p>x</p>', expectedVersion: 3 });
    assert.deepStrictEqual(conflict, { ok: false, conflict: true });

    reset();
    state.rowCount = 0; state.existsOnReRead = false;   // row isn't ours / gone
    const missing = await notebookStore.updateNotebookCas('nb1', 'u1', { documentContent: '<p>x</p>', expectedVersion: 3 });
    assert.deepStrictEqual(missing, { ok: false, conflict: false }, 'a 404 must not be reported as a retryable conflict');
});

test('without expectedVersion a 0-row update is a plain failure, no re-read', async () => {
    reset();
    state.rowCount = 0;
    const r = await notebookStore.updateNotebookCas('nb1', 'u1', { name: 'x' });
    assert.deepStrictEqual(r, { ok: false, conflict: false });
});

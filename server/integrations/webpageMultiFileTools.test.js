// @typecheck
/**
 * executeMultiFileTool dispatches by tool name: an unknown name, the reserved
 * primary slots, the listings and the find/replace keep their answers and
 * writes. The webpage store's methods are swapped for an in-memory fake.
 *
 * Run: cd server && node --test integrations/webpageMultiFileTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

require('../testUtils/routeHarness').recordDb();
const webpageStore = require('../stores/webpageStore');
const { executeMultiFileTool } = require('./webpageMultiFileTools');

/**
 * Run `fn` with the store's extra-file methods over `files` (path → text, or null for a binary).
 * @param {Record<string, string | null>} files
 * @param {(writes: string[]) => Promise<void>} fn
 */
async function withFiles(files, fn) {
    /** @type {string[]} */
    const writes = [];
    const meta = (/** @type {string} */ path) => ({ path, size: (files[path] ?? 'bin').length, isText: files[path] !== null, mimeType: files[path] === null ? 'image/png' : 'text/plain' });
    /** @type {Record<string, unknown>} */
    const fakes = {
        listExtraFiles: async () => Object.keys(files).map(meta),
        getWebpage: async () => ({ htmlSize: 10, cssSize: 0, jsSize: 0 }),
        validateExtraPath: () => null,
        readExtraFile: async (/** @type {{ path: string }} */ { path }) => (path in files ? { meta: meta(path), text: files[path] } : null),
        upsertExtraFile: async (/** @type {{ path: string, content: string }} */ { path, content }) => { writes.push(`${path}=${content}`); files[path] = content; return meta(path); },
        deleteExtraFile: async (/** @type {{ path: string }} */ { path }) => { writes.push(`-${path}`); return path in files; },
    };
    const store = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (webpageStore));
    const saved = Object.keys(fakes).map((k) => [k, store[k]]);
    Object.assign(store, fakes);
    try { await fn(writes); } finally { for (const [k, v] of saved) store[/** @type {string} */ (k)] = v; }
}

const ctx = { webpageId: 'w1', userId: 'u1' };

test('an unknown name, a reserved slot, and the two listings', async () => {
    await withFiles({ 'data.json': '{}', 'logo.png': null }, async (writes) => {
        assert.deepEqual(await executeMultiFileTool('webpage_nope', {}, ctx), { error: 'Unknown multi-file tool: webpage_nope' });
        assert.match(String((await executeMultiFileTool('webpage_create_file', { path: 'style.css', content: 'x' }, ctx)).error), /use webpage_file_write\(\{ file: "css"/);
        const files = await executeMultiFileTool('webpage_list_files', {}, ctx);
        assert.deepEqual(files.files.map((/** @type {{ path: string }} */ f) => f.path), ['index.html', 'style.css', 'script.js', 'data.json', 'logo.png']);
        assert.equal(files.message, 'Project has 3 primary slots + 2 extra files.');
        const assets = await executeMultiFileTool('webpage_list_assets', {}, ctx);
        assert.deepEqual(assets.assets, [{ path: 'logo.png', mimeType: 'image/png', size: 3 }]);
        assert.deepEqual(writes, []);
    });
});

test('replace_in_file refuses an ambiguous match, replaces all on request; read and delete answer as before', async () => {
    await withFiles({ 'a.txt': 'x-x', 'logo.png': null }, async (writes) => {
        assert.match(String((await executeMultiFileTool('webpage_replace_in_file', { path: 'a.txt', find_text: 'x' }, ctx)).error), /matches 2 places in a\.txt \(lines 1, 1\)/);
        const out = await executeMultiFileTool('webpage_replace_in_file', { path: 'a.txt', find_text: 'x', replace_text: 'y', replace_all: true }, ctx);
        assert.deepEqual([out._action, out.message], ['webpage_extra_update', 'a.txt updated (2 replacements, lines 1, 1).']);
        assert.equal((await executeMultiFileTool('webpage_read_file', { path: 'logo.png' }, ctx)).isBinary, true);
        assert.deepEqual(await executeMultiFileTool('webpage_delete_file', { path: 'gone.txt' }, ctx), { error: 'File "gone.txt" not found.' });
        assert.deepEqual(writes, ['a.txt=y-y', '-gone.txt']);
    });
});

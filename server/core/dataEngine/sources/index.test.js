/**
 * The source registry — what keeps a second kind from being a second engine.
 *
 * Three things are pinned, each of which would rot silently:
 *   1. LOCKSTEP. The registry's kinds, the store's literal SOURCE_KINDS (a
 *      store may not require core/) and the managedTables kinds marked
 *      `fieldsFromSource` are three spellings of one list.
 *   2. LAZINESS. Requiring the registry loads neither adapter, and asking
 *      for one kind loads only that kind — the ticker's test stubs only the
 *      Nextcloud engine, and a spreadsheet adapter pulled in at load would
 *      drag its provider clients into every consumer.
 *   3. NO STRAY KIND STRINGS. Every consumer goes through the registry; the
 *      literal 'nextcloud_table' may appear only where the kind is DEFINED
 *      (its adapter folder, the managedTables contract, the store's literal
 *      list, the migrations) — anywhere else it is a consumer that would
 *      treat a spreadsheet mirror as a plain table.
 *
 * Run: cd server && node --test core/dataEngine/sources/index.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..', '..', '..');
const HERE = __dirname;

const INTERFACE_KEYS = [
    'KIND', 'TAG', 'label', 'builderKind', 'isMirror', 'errors', 'resolveLinker', 'apiFor', 'siblingsOf',
    'open', 'deriveFields', 'rowFromSource', 'sync', 'writeThrough', 'link', 'events', 'publicSource',
];

test('the three spellings of the kind list agree', () => {
    const sources = require('./index');
    const { SOURCE_KINDS: storeKinds } = require('../../../stores/datatableStore');
    const { MANAGED_KINDS } = require('../dataModel/managedTables');
    const fromSpec = Object.keys(MANAGED_KINDS).filter(k => MANAGED_KINDS[k].fieldsFromSource);
    assert.deepStrictEqual([...sources.SOURCE_KINDS], [...storeKinds]);
    assert.deepStrictEqual([...sources.SOURCE_KINDS].sort(), fromSpec.sort());
});

test('requiring the registry loads neither kind; asking for one loads only that one', () => {
    // A child process, so this file's own requires cannot muddy the cache.
    const script = `
        const before = new Set(Object.keys(require.cache));
        const sources = require(${JSON.stringify(path.join(HERE, 'index.js'))});
        const loadedBy = (needle) => Object.keys(require.cache).some(f => !before.has(f) && f.includes(needle));
        const a = { nc: loadedBy('/nextcloudTable/'), ss: loadedBy('/spreadsheetFile/') };
        void sources.SOURCE_KINDS; void sources.sourceLabel('nextcloud_table'); void sources.builderKindOf('spreadsheet_file'); void sources.isSourceMirror({ managedKind: 'nextcloud_table' });
        const b = { nc: loadedBy('/nextcloudTable/'), ss: loadedBy('/spreadsheetFile/') };
        sources.adapterFor('nextcloud_table');
        const c = { nc: loadedBy('/nextcloudTable/'), ss: loadedBy('/spreadsheetFile/') };
        process.stdout.write(JSON.stringify({ a, b, c }));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: SERVER, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(out.a, { nc: false, ss: false }, 'require alone loads nothing');
    assert.deepStrictEqual(out.b, { nc: false, ss: false }, 'the pure lookups load nothing');
    assert.deepStrictEqual(out.c, { nc: true, ss: false }, 'one kind asked for, one kind loaded');
});

test('every adapter exposes the whole interface, and the spreadsheet one answers on every member the routes reach', async () => {
    const sources = require('./index');
    for (const kind of sources.SOURCE_KINDS) {
        const adapter = sources.adapterFor(kind);
        for (const key of INTERFACE_KEYS) {
            assert.ok(key in adapter, `${kind}: ${key}`);
        }
        assert.strictEqual(adapter.KIND, kind);
        assert.strictEqual(typeof adapter.isMirror, 'function');
        assert.strictEqual(sources.builderKindOf(kind), adapter.builderKind);
    }
    const nc = sources.adapterFor('nextcloud_table');
    assert.strictEqual(nc.TAG, '[NextcloudTable]');
    assert.strictEqual(nc.builderKind, 'nextcloud');
    assert.strictEqual(typeof nc.sync.syncRows, 'function');
    assert.strictEqual(typeof nc.writeThrough.insertRow, 'function');
    assert.strictEqual(typeof nc.link.applySettings, 'function');
    const ss = sources.adapterFor('spreadsheet_file');
    assert.strictEqual(ss.TAG, '[SpreadsheetFile]');
    assert.strictEqual(ss.builderKind, 'spreadsheet');
    assert.strictEqual(typeof ss.open, 'function');
    assert.strictEqual(typeof ss.sync.syncRows, 'function');
    assert.strictEqual(typeof ss.sync.kickStale, 'function');
    for (const k of ['providers', 'browse', 'describe', 'linkSpreadsheets', 'setRelations', 'relink', 'applySettings', 'unlinked']) {
        assert.strictEqual(typeof ss.link[k], 'function', `link.${k}`);
    }
    // A read-only file is refused BEFORE anything is probed — never a silent
    // local write that the next pass would sweep away.
    for (const k of ['insertRow', 'updateRow', 'deleteRow', 'insertRows', 'updateRows', 'deleteRows']) {
        await assert.rejects(ss.writeThrough[k]({ table: { source: { provider: 'onedrive', write: { mode: 'none', reason: 'ods' } } } }), (e) => e.code === 'spreadsheet_write_unsupported' && e.status === 409 && e.reason === 'ods', `writeThrough.${k}`);
    }
    assert.strictEqual(typeof ss.writeThrough.contextOf, 'function');
    // A storage push reaches the kind through these two — the events route
    // and the msgraph webhook call nothing else.
    assert.strictEqual(typeof ss.events.onFileEvent, 'function');
    assert.strictEqual(typeof ss.events.onProviderHint, 'function');
});

test('the lookups answer by table kind and never by string comparison at the call site', () => {
    const sources = require('./index');
    const nc = { managedKind: 'nextcloud_table', source: { kind: 'nextcloud_table', ncTableId: 4 } };
    const plain = { managedKind: null };
    const cache = { managedKind: 'http_cache' };
    assert.strictEqual(sources.isSourceMirror(nc), true);
    assert.strictEqual(sources.isSourceMirror(plain), false);
    assert.strictEqual(sources.isSourceMirror(cache), false, 'a managed kind is not a source kind');
    assert.strictEqual(sources.isSourceMirror(null), false);
    assert.strictEqual(sources.sourceOf(plain), null);
    assert.strictEqual(sources.kickStale(plain, { reason: 'view' }), false, 'a read site may call it unconditionally');
    assert.strictEqual(sources.sourceLabel(nc), 'Nextcloud');
    assert.strictEqual(sources.sourceLabel('spreadsheet_file'), 'the spreadsheet');
    assert.strictEqual(sources.sourceLabel(plain), 'the source');
    assert.strictEqual(sources.builderKindOf('nextcloud_table'), 'nextcloud');
    assert.strictEqual(sources.builderKindOf('spreadsheet_file'), 'spreadsheet');
    assert.strictEqual(sources.builderKindOf(null), 'studio');
    assert.strictEqual(sources.builderKindOf('http_cache'), 'studio');
    assert.throws(() => sources.adapterFor('constructor'), /unknown source kind/);
    assert.throws(() => sources.writeThrough(plain), /unknown source kind/);
    assert.deepStrictEqual(sources.publicSourceExtras({ kind: 'bogus' }), {});
    const extras = sources.publicSourceExtras({ kind: 'nextcloud_table', ncTableId: 4, ncBaseUrl: 'http://nc/' });
    assert.strictEqual(extras.ncTableId, 4);
    assert.strictEqual(extras.ncUrl, 'http://nc/apps/tables/#/table/4');
});

// Where the literal may live: the kind's own folder, the contract, the
// store's literal list, the migrations, and test fixtures.
const ALLOWED = [
    /^core\/dataEngine\/sources\/nextcloudTable\//,
    /^core\/dataEngine\/dataModel\/managedTables\.js$/,
    // De store is een facade met zijn onderdelen in stores/datatableStore/;
    // de literele lijst woont in sourceMirrors.js. Zelfde module, zelfde recht.
    /^stores\/datatableStore(\.js|\/)/,
    /^migrations\//,
    /\/_fixtures\//,
    /\.test\.js$/,
];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'assets', 'prompts', '.git', 'dist', 'coverage']);
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, out); }
        else if (/\.js$/.test(e.name)) out.push(full);
    }
    return out;
}

test('no consumer compares the kind by its literal — every site goes through the registry', () => {
    const offenders = [];
    for (const file of walk(SERVER)) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        if (ALLOWED.some(re => re.test(rel))) continue;
        const src = fs.readFileSync(file, 'utf8');
        if (/['"]nextcloud_table['"]/.test(src)) offenders.push(rel);
    }
    assert.deepStrictEqual(offenders, [],
        'a literal \'nextcloud_table\' outside the kind\'s own folder is a consumer that would treat a spreadsheet mirror as a plain table:\n  ' + offenders.join('\n  '));
});

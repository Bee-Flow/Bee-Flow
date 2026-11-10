/**
 * Dutch per namespace: ./<namespace>.json next to ../en/<namespace>.js. The
 * loader checks each file's shape and namespace, and the files that exist
 * cover what they must: every English namespace that en/index.js DISCOVERS
 * (a namespace added since discovery, which no add-nl-* catalogue knows) has
 * its Dutch here, key for key.
 *
 * Run: node --test i18n/defaults/nl/index.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listFiles, loadNamespaceFiles, sourceHash, NL_DIR } = require('.');
const { GUI_DEFAULTS, DISCOVERED_NAMESPACES } = require('../en');

/** @param {Record<string, unknown>} files name -> JSON value, or a string written as is */
function tempDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-nl-files-'));
    for (const [name, v] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
    }
    return dir;
}

/** @param {string} dir @param {() => void} fn */
function inDir(dir, fn) {
    try { fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('files are merged in file-name order; index.js and tests are not data', () => {
    const dir = tempDir({
        'b_ns.json': { translations: { 'b_ns.one': 'Een' }, sameAsEnglish: ['b_ns.brand'] },
        'a_ns.json': { translations: { 'a_ns.one': 'Een', 'a_ns.two': 'Twee' }, sameAsEnglish: [] },
        'index.js': '', 'index.test.js': '',
    });
    inDir(dir, () => {
        assert.deepStrictEqual(listFiles(dir), ['a_ns.json', 'b_ns.json']);
        const loaded = loadNamespaceFiles(dir);
        assert.deepStrictEqual(loaded.namespaces, ['a_ns', 'b_ns']);
        assert.deepStrictEqual(Object.keys(loaded.translations), ['a_ns.one', 'a_ns.two', 'b_ns.one']);
        assert.deepStrictEqual(loaded.sameAsEnglish, ['b_ns.brand']);
    });
});

test('a file in the wrong shape, a key of another namespace, an empty value or a stray file throws', () => {
    const cases = [
        [{ 'x.json': { translations: {} } }, /must be/],
        [{ 'x.json': { translations: { 'y.one': 'Een' }, sameAsEnglish: [] } }, /not in namespace "x"/],
        [{ 'x.json': { translations: { 'x_more.one': 'Een' }, sameAsEnglish: [] } }, /not in namespace "x"/],
        [{ 'x.json': { translations: { 'x.one': ' ' }, sameAsEnglish: [] } }, /has no Dutch text/],
        [{ 'x.json': { translations: { 'x.one': 'Een' }, sameAsEnglish: ['x.one'] } }, /both translated and declared/],
        [{ 'x.json': { translations: {}, sameAsEnglish: ['y.one'] } }, /not a key of namespace "x"/],
        [{ 'x.js': '' }, /not a namespace data file/],
        [{ 'studio-apps.json': { translations: {}, sameAsEnglish: [] } }, /not a namespace data file/],
    ];
    for (const [files, error] of cases) {
        const dir = tempDir(/** @type {Record<string, unknown>} */ (files));
        inDir(dir, () => assert.throws(() => loadNamespaceFiles(dir), /** @type {RegExp} */ (error), JSON.stringify(files)));
    }
});

test('the source hash changes when a file is added or changed, and only then', () => {
    const one = { translations: { 'a_ns.one': 'Een' }, sameAsEnglish: [] };
    const dir = tempDir({ 'a_ns.json': one });
    inDir(dir, () => {
        const first = sourceHash(dir);
        assert.match(first, /^[0-9a-f]{64}$/);
        assert.strictEqual(sourceHash(dir), first);
        fs.writeFileSync(path.join(dir, 'b_ns.json'), JSON.stringify({ translations: { 'b_ns.one': 'Een' }, sameAsEnglish: [] }));
        const added = sourceHash(dir);
        assert.notStrictEqual(added, first);
        fs.writeFileSync(path.join(dir, 'a_ns.json'), JSON.stringify({ translations: { 'a_ns.one': 'Eén' }, sameAsEnglish: [] }));
        assert.notStrictEqual(sourceHash(dir), added);
    });
});

test('the real files load, and each one belongs to an English namespace', () => {
    const { namespaces } = loadNamespaceFiles();
    for (const ns of namespaces) {
        assert.ok(fs.existsSync(path.join(NL_DIR, '..', 'en', `${ns}.js`)), `nl/${ns}.json has no en/${ns}.js`);
    }
});

test('every discovered English namespace has its Dutch here, key for key', () => {
    const { translations, sameAsEnglish } = loadNamespaceFiles();
    const covered = new Set([...Object.keys(translations), ...sameAsEnglish]);
    const discovered = new Set(DISCOVERED_NAMESPACES);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => discovered.has(k.split('.')[0]) && !covered.has(k));
    assert.deepStrictEqual(untranslated, [],
        'put the Dutch in server/i18n/defaults/nl/<namespace>.json ("translations", or "sameAsEnglish" when the Dutch is the English)');
});

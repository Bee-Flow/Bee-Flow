/**
 * A new English namespace is a new file in ./en/ and nothing else: en/index.js
 * finds it, merges it AFTER the namespaces it lists (whose order fixes the
 * bytes of the generated agent-hub copy), and in file-name order, so the
 * result of a merge of two branches that each added one does not depend on
 * which merged first.
 *
 * Run: node --test i18n/defaults/en.discovery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EN_DIR = path.join(__dirname, 'en');
const { GUI_DEFAULTS, discoverNamespaces, LISTED_NAMESPACES, DISCOVERED_NAMESPACES } = require('./en');

/** @param {Record<string, string>} files name -> content */
function tempDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-en-discovery-'));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
}

test('discovery returns the unlisted namespace files in file-name order, and skips index.js and other file types', () => {
    const dir = tempDir({ 'index.js': '', 'b_new.js': '', 'a_new.js': '', 'listed.js': '', 'notes.md': '', 'data.json': '{}' });
    try {
        assert.deepStrictEqual(discoverNamespaces(dir, new Set(['listed'])), ['a_new', 'b_new']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a .js file whose name is not a namespace name throws instead of being skipped', () => {
    for (const bad of ['studio-apps.js', 'x.test.js', '1abc.js', '_x.js']) {
        const dir = tempDir({ [bad]: '' });
        try {
            assert.throws(() => discoverNamespaces(dir, new Set()), /is not a namespace file/, bad);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('every namespace file in en/ is merged: listed or discovered, never both, never neither', () => {
    const onDisk = fs.readdirSync(EN_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js').map((f) => f.slice(0, -3)).sort();
    const listed = new Set(LISTED_NAMESPACES);
    assert.deepStrictEqual(DISCOVERED_NAMESPACES.filter((ns) => listed.has(ns)), []);
    assert.deepStrictEqual([...LISTED_NAMESPACES, ...DISCOVERED_NAMESPACES].sort(), onDisk);
    for (const ns of onDisk) {
        for (const key of Object.keys(require(path.join(EN_DIR, `${ns}.js`)))) {
            assert.ok(Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, key), `${key} from en/${ns}.js is not in GUI_DEFAULTS`);
        }
    }
});

test('the listed namespaces keep their place: their keys come first, the discovered ones after them, sorted', () => {
    const seen = [];
    for (const key of Object.keys(GUI_DEFAULTS)) {
        const ns = key.split('.')[0];
        if (seen[seen.length - 1] !== ns) seen.push(ns);
    }
    const withKeys = new Set(seen);
    const expected = [...LISTED_NAMESPACES, ...DISCOVERED_NAMESPACES].filter((ns) => withKeys.has(ns));
    assert.deepStrictEqual(seen, expected, 'each namespace is one run of keys, in listed-then-discovered order');
    assert.deepStrictEqual([...DISCOVERED_NAMESPACES], [...DISCOVERED_NAMESPACES].sort());
});

test('the App Studio schema namespace is found without a NAMESPACES entry', () => {
    assert.ok(DISCOVERED_NAMESPACES.includes('studio_apps_schema'));
    assert.ok(GUI_DEFAULTS['studio_apps_schema.newer_than_install']);
});

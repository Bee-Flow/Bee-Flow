/**
 * A new English namespace is a new file in ./en/ and nothing else: en/index.js
 * finds it, merges it AFTER the namespaces it lists (whose order fixes the
 * bytes of the generated agent-hub copy), and in file-name order, so the
 * result of a merge of two branches that each added one does not depend on
 * which merged first.
 *
 * The files come from the tree (i18n/defaults/en/ over every root, see
 * server/moduleRoots.cjs): a module keeps its namespace files in its own root,
 * and a pinned namespace whose file is absent is skipped.
 *
 * Run: node --test i18n/defaults/en.discovery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { listTreeDir } = require('../../moduleRoots.cjs');
const { i18nTreeFixture } = require('./treeFixture.testkit.js');
const {
    GUI_DEFAULTS, discoverNamespaces, namespaceFiles, NAMESPACES, LISTED_NAMESPACES, SKIPPED_NAMESPACES, DISCOVERED_NAMESPACES,
} = require('./en');

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

test('every namespace file of the tree is merged: listed or discovered, never both, never neither', () => {
    const present = listTreeDir('i18n/defaults/en').filter((f) => f.name.endsWith('.js') && f.name !== 'index.js');
    const onDisk = present.map((f) => f.name.slice(0, -3)).sort();
    const listed = new Set(LISTED_NAMESPACES);
    assert.deepStrictEqual(DISCOVERED_NAMESPACES.filter((ns) => listed.has(ns)), []);
    assert.deepStrictEqual([...LISTED_NAMESPACES, ...DISCOVERED_NAMESPACES].sort(), onDisk);
    for (const file of present) {
        for (const key of Object.keys(require(file.abs))) {
            assert.ok(Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, key), `${key} from en/${file.name} is not in GUI_DEFAULTS`);
        }
    }
});

test('the pinned namespaces split into present (listed) and absent (skipped), in pinned order', () => {
    assert.deepStrictEqual([...LISTED_NAMESPACES, ...SKIPPED_NAMESPACES].sort(), [...NAMESPACES].sort());
    assert.deepStrictEqual([...LISTED_NAMESPACES], NAMESPACES.filter((ns) => LISTED_NAMESPACES.includes(ns)));
    assert.strictEqual(new Set(NAMESPACES).size, NAMESPACES.length, 'a pinned namespace is listed once');
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

// That the App Studio schema namespace (the apps module's) is found without a NAMESPACES entry is
// checked in en.discovery.apps.test.js.

// -- Namespace files in more than one root (server/moduleRoots.cjs) ----------
// A module keeps its namespace files in modules/<id>/server/i18n/defaults/en/.
// The pinned order still decides where they go, and a pinned namespace whose
// file is absent (module not installed, or hidden in core mode) is skipped.

/** @param {string} ns @param {string[]} keys */
const nsFile = (ns, keys) => `module.exports = ${JSON.stringify(Object.fromEntries(keys.map((k) => [`${ns}.${k}`, k])))};\n`;

const REPORT = "const e = require('./i18n/defaults/en/index.js'); process.stdout.write(JSON.stringify({"
    + ' keys: Object.keys(e.GUI_DEFAULTS), listed: e.LISTED_NAMESPACES, skipped: e.SKIPPED_NAMESPACES, discovered: e.DISCOVERED_NAMESPACES }));';

test('a namespace file in a module root is loaded in its pinned position; an absent pinned one is skipped', () => {
    assert.deepStrictEqual(NAMESPACES.slice(0, 4), ['appearance', 'nc_onboarding', 'init_setup', 'activity']);
    const tree = i18nTreeFixture('en', {
        core: { 'appearance.js': nsFile('appearance', ['a']), 'activity.js': nsFile('activity', ['b']), 'a_core_new.js': nsFile('a_core_new', ['c']) },
        module: { 'nc_onboarding.js': nsFile('nc_onboarding', ['d', 'e']), 'zz_module_new.js': nsFile('zz_module_new', ['f']) },
    });
    try {
        const all = tree.run(REPORT);
        assert.deepStrictEqual(all.keys, ['appearance.a', 'nc_onboarding.d', 'nc_onboarding.e', 'activity.b', 'a_core_new.c', 'zz_module_new.f']);
        assert.deepStrictEqual(all.listed, ['appearance', 'nc_onboarding', 'activity']);
        assert.deepStrictEqual(all.discovered, ['a_core_new', 'zz_module_new']);
        assert.ok(all.skipped.includes('init_setup'));
        assert.strictEqual(all.listed.length + all.skipped.length, NAMESPACES.length);

        const coreMode = tree.run(REPORT, { hide: 'x' });
        assert.deepStrictEqual(coreMode.keys, ['appearance.a', 'activity.b', 'a_core_new.c']);
        assert.ok(coreMode.skipped.includes('nc_onboarding'));
        assert.deepStrictEqual(coreMode.discovered, ['a_core_new']);
    } finally {
        tree.remove();
    }
});

test('a file in a module root meets the same guards: a bad name, a key in the wrong namespace', () => {
    assert.throws(() => namespaceFiles([{ name: 'bad-name.js', abs: '/x/bad-name.js', moduleId: 'x' }]),
        /bad-name\.js in i18n\/defaults\/en\/ of module "x" is not a namespace file/);
    const tree = i18nTreeFixture('en', {
        core: { 'appearance.js': nsFile('appearance', ['a']) },
        module: { 'nc_onboarding.js': "module.exports = { 'other.k': 'v' };\n" },
    });
    try {
        assert.throws(() => tree.run(REPORT), (e) => /key "other\.k" is in en\/nc_onboarding\.js but its namespace is "other"/.test(String(/** @type {any} */ (e).stderr)));
    } finally {
        tree.remove();
    }
});

/**
 * The pinned namespaces whose file no root of this checkout holds. In core mode
 * (BEEFLOW_HIDE_MODULES) the hidden modules' namespaces are skipped by design, so the checkout
 * is read in a child process with every module visible; otherwise this process's answer.
 * @returns {string[]}
 */
function skippedInCheckout() {
    if (!process.env.BEEFLOW_HIDE_MODULES) return [...SKIPPED_NAMESPACES];
    const env = { ...process.env };
    for (const key of ['BEEFLOW_HIDE_MODULES', 'NODE_TEST_CONTEXT']) delete env[key];
    const server = path.resolve(__dirname, '..', '..');
    const r = spawnSync(process.execPath, ['--require', path.join(server, 'moduleRoots.cjs'), '-e',
        "process.stdout.write(JSON.stringify(require('./i18n/defaults/en/index.js').SKIPPED_NAMESPACES));"],
    { cwd: server, env, encoding: 'utf8', timeout: 60_000 });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

test('in this checkout no pinned namespace is skipped', () => {
    assert.deepStrictEqual(skippedInCheckout(), []);
});

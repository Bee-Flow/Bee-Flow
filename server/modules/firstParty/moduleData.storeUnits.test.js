'use strict';
/**
 * migrationOwners.json "storeUnits" (read by modules/firstParty/moduleData.js) agrees with the
 * tree, every module visible: every literal makeStoreInit(<tag>, ...) in a source file that
 * scripts/module-map.json gives to a module is recorded as `store:<tag>` under that module, and
 * nothing else is. Every store row of every composition (firstParty/<id>.stores.js) reaches a
 * unit of its own module through its file or the module's files that file requires, or is listed
 * below with the reason it has none. The tag is read by a static scan of the source, as the
 * ledger names the unit after it (stores/lib/storeInit.js).
 *
 * Run: cd server && node --test modules/firstParty/moduleData.storeUnits.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OWNERS = require('./migrationOwners.json');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SOURCE = /\.(c?js|mts)$/;
const NOT_SOURCE = /\.test\.|\.testkit\.|^testUtils\/|^scripts\/|^journeys\//;
const TAG = /makeStoreInit\(\s*['"`]([^'"`$]+)['"`]/g;
const RELATIVE = /(?:require|nodeRequire)\(\s*['"](\.[^'"]+)['"]\s*\)|^\s*import\b[^'"]*?['"](\.[^'"]+)['"]/gm;

/** Composition store rows without a ledger unit of their own, and why. */
const WITHOUT_UNIT = {};

/** @type {{ files: Map<string, { abs: string, src: string }>, ownerOf: (treePath: string) => string | null }} */
let tree;

before(async () => {
    const { walkTree } = await import(path.join(REPO, 'scripts', 'lib', 'roots.mjs'));
    const { loadModuleMap } = await import(path.join(REPO, 'scripts', 'module-map.mjs'));
    const map = loadModuleMap();
    /** @type {Map<string, { abs: string, src: string }>} */
    const files = new Map();
    for (const f of walkTree('server')) {
        if (!SOURCE.test(f.treePath) || NOT_SOURCE.test(f.treePath) || files.has(f.treePath)) continue;
        files.set(f.treePath, { abs: f.abs, src: fs.readFileSync(f.abs, 'utf8') });
    }
    tree = { files, ownerOf: (treePath) => map.ownerOf('server', treePath) || null };
});

/** @param {string} src */
const tagsIn = (src) => [...src.matchAll(TAG)].map((m) => /** @type {string} */ (m[1]));

/**
 * The tree path a relative request from `from` lands on, or null.
 * @param {string} from
 * @param {string} spec
 */
function resolveIn(from, spec) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    for (const c of [base, `${base}.js`, `${base}.mts`, `${base}.cjs`, `${base}/index.js`]) if (tree.files.has(c)) return c;
    return null;
}

/**
 * The units reachable from a store file through the files of the same module it requires.
 * @param {string} start
 * @param {string} moduleId
 */
function unitsReachedFrom(start, moduleId) {
    const units = new Set();
    const todo = [start];
    const seen = new Set();
    while (todo.length > 0) {
        const file = /** @type {string} */ (todo.pop());
        if (seen.has(file)) continue;
        seen.add(file);
        const src = /** @type {{ src: string }} */ (tree.files.get(file)).src;
        for (const tag of tagsIn(src)) units.add(`store:${tag}`);
        for (const m of src.matchAll(RELATIVE)) {
            const next = resolveIn(file, /** @type {string} */ (m[1] || m[2]));
            if (next && tree.ownerOf(next) === moduleId) todo.push(next);
        }
    }
    return units;
}

test('storeUnits records exactly the ledger units of the module-owned store files, under their owner', () => {
    /** @type {Record<string, string>} */
    const scanned = {};
    /** @type {Map<string, string>} */
    const fileOfTag = new Map();
    for (const [treePath, { src }] of tree.files) {
        for (const tag of tagsIn(src)) {
            const earlier = fileOfTag.get(tag);
            assert.ok(earlier === undefined || earlier === treePath, `ledger unit store:${tag} is named by ${earlier} and ${treePath}`);
            fileOfTag.set(tag, treePath);
            const owner = tree.ownerOf(treePath);
            if (owner) scanned[`store:${tag}`] = owner;
        }
    }
    const sorted = Object.fromEntries(Object.entries(scanned).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    assert.deepEqual(OWNERS.storeUnits, sorted);
});

test('every store row of every composition reaches a unit of its own module, or says why not', () => {
    /** @type {string[]} */
    const missing = [];
    for (const [treePath, { src }] of tree.files) {
        const m = /^firstParty\/(\w+)\.stores\.js$/.exec(treePath);
        if (!m) continue;
        const moduleId = /** @type {string} */ (m[1]);
        for (const row of src.matchAll(/\{\s*name:\s*'(\w+)',\s*file:\s*'\.\/([^']+)'/g)) {
            const [, name, file] = /** @type {[string, string, string]} */ (/** @type {unknown} */ (row));
            const start = resolveIn('index.js', `./${file}`);
            assert.ok(start, `${treePath}: row ${name} names ${file}, which is not in the tree`);
            const units = [...unitsReachedFrom(start, moduleId)].filter((u) => OWNERS.storeUnits[u] === moduleId);
            if (units.length === 0 && !Object.prototype.hasOwnProperty.call(WITHOUT_UNIT, name)) missing.push(`${moduleId}: ${name} (${file})`);
        }
    }
    assert.deepEqual(missing, []);
});

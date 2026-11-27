// @typecheck strict
'use strict';
/**
 * The English dictionary and the Dutch catalogues of the WHOLE tree, for the catalogue tests.
 *
 * In core mode (BEEFLOW_HIDE_MODULES) the English dictionary leaves out the namespaces of the
 * hidden modules (i18n/defaults/en/index.js) and a catalogue a module owns does not load. A
 * core catalogue that mixes core and module keys, and a test that compares catalogues with
 * each other, answer to the dictionary and the catalogues of every root: they guard the
 * repository, not one edition. So this kit reads them in a child process with every module
 * visible, and in-process when nothing is hidden (the same answer, without the child).
 *
 * It sits here, not in migrations/, because every file there is a migration to the ladder's
 * guard (boot/bootMigrations.test.js).
 *
 *   const { english, catalogue } = require('../i18n/defaults/treeI18n.testkit');   // from migrations/
 *   english()                                  GUI_DEFAULTS over every root
 *   catalogue('add-nl-project-rail-translations')   its exports, functions left out
 *   catalogues(names)                          name -> exports, one read for all of them
 *   catalogueFile('add-nl-x.js')               one catalogue file of migrations/, out of one read of all
 *   loadTree(names)                            { english, catalogues, upTypes, errors } in one go
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..', '..');
/** The directory of the Dutch catalogues (add-nl-* / update-nl-*). */
const MIGRATIONS = path.join(SERVER, 'migrations');

/**
 * @typedef {{
 *   english: Record<string, string>,
 *   catalogues: Record<string, Record<string, any>>,
 *   upTypes: Record<string, string>,
 *   errors: Record<string, string>,
 * }} TreeI18n
 */

/**
 * Read the dictionary and the named catalogues in this process.
 * @param {string[]} names catalogue file names under migrations/, without .js
 * @returns {TreeI18n}
 */
function collect(names) {
    /** @type {TreeI18n} */
    const out = { english: require('./en').GUI_DEFAULTS, catalogues: {}, upTypes: {}, errors: {} };
    for (const name of names) {
        try {
            /** @type {Record<string, unknown>} */
            const mod = require(path.join(MIGRATIONS, name));
            out.upTypes[name] = typeof mod.up;
            out.catalogues[name] = Object.fromEntries(Object.entries(mod).filter(([, v]) => typeof v !== 'function'));
        } catch (e) {
            out.errors[name] = /** @type {Error} */ (e).message;
        }
    }
    return out;
}

/**
 * The same, in a child process with every module visible.
 * @param {string[]} names
 * @returns {TreeI18n}
 */
function collectInChild(names) {
    const env = { ...process.env };
    for (const key of ['BEEFLOW_HIDE_MODULES', 'NODE_TEST_CONTEXT']) delete env[key];
    const code = 'process.stdout.write(`\\n@@result@@${JSON.stringify(require(process.argv[1]).collect(JSON.parse(process.argv[2])))}`);';
    const r = spawnSync(process.execPath, ['--require', path.join(SERVER, 'moduleRoots.cjs'), '-e', code, __filename, JSON.stringify(names)],
        { cwd: SERVER, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`treeI18n child failed (exit ${r.status}): ${String(r.stderr || r.error).slice(-2000)}`);
    return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('@@result@@') + '@@result@@'.length)); // after anything a file logged
}

/** @type {Map<string, TreeI18n>} */
const cache = new Map();

/**
 * @param {string[]} [names]
 * @returns {TreeI18n}
 */
function loadTree(names = []) {
    const key = JSON.stringify(names);
    let got = cache.get(key);
    if (!got) {
        got = process.env.BEEFLOW_HIDE_MODULES ? collectInChild(names) : collect(names);
        cache.set(key, got);
    }
    return got;
}

/** @returns {Record<string, string>} the English dictionary over every root */
const english = () => loadTree().english;

/**
 * @param {string} name a catalogue file name under migrations/, without .js
 * @returns {Record<string, any>} its exports, functions left out
 */
function catalogue(name) {
    const got = loadTree([name]);
    const table = got.catalogues[name];
    if (!table) throw new Error(`${name}: ${got.errors[name] || 'not loaded'}`);
    return table;
}

/**
 * Several catalogues in one read (one child process in core mode).
 * @param {string[]} names
 * @returns {Record<string, Record<string, any>>} name -> its exports, functions left out, in the order of `names`
 */
function catalogues(names) {
    const got = loadTree(names);
    for (const name of names) if (!got.catalogues[name]) throw new Error(`${name}: ${got.errors[name] || 'not loaded'}`);
    return got.catalogues;
}

/** @returns {string[]} the Dutch catalogues (add-nl-* / update-nl-*) of this directory, sorted */
function catalogueNames() {
    return fs.readdirSync(MIGRATIONS)
        .filter((f) => /^(add|update)-nl-.*\.js$/.test(f) && !f.endsWith('.test.js'))
        .map((f) => f.slice(0, -'.js'.length))
        .sort();
}

/**
 * One catalogue file of this directory, out of one whole-tree read of all of them. Throws, as
 * require() would, when it does not load.
 * @param {string} file e.g. 'add-nl-foo-translations.js'
 * @returns {Record<string, any>}
 */
function catalogueFile(file) {
    const name = file.replace(/\.js$/, '');
    const got = loadTree(catalogueNames());
    const table = got.catalogues[name];
    if (!table) throw new Error(`${name}: ${got.errors[name] || 'not a catalogue of migrations/'}`);
    return table;
}

module.exports = { loadTree, english, catalogue, catalogues, catalogueFile, catalogueNames, collect };

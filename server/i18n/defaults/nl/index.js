// @typecheck strict
'use strict';
/**
 * Dutch for namespaces, one data file per namespace: ./<namespace>.json, next
 * to the English ../en/<namespace>.js. Whoever writes the English namespace
 * file writes its Dutch file; nothing else is edited. One catalogue
 * (migrations/add-nl-namespace-files.js) seeds every file found here, and the
 * boot ladder re-runs it whenever a file here is added or changed
 * (sourceHash below is part of its ledger checksum).
 *
 * A file holds
 *   { "translations": { "<namespace>.<key>": "Dutch", ... },
 *     "sameAsEnglish": [ "<namespace>.<key>", ... ] }
 * where sameAsEnglish lists keys whose Dutch IS the English (a product name):
 * declared, not seeded. Every key must belong to the file's namespace, so two
 * files can never claim the same key.
 *
 * Seeding fills only keys the stored 'nl' blob does not have yet, like every
 * add-nl-* catalogue: a key an organisation already has (its own wording, or
 * Dutch shipped earlier) is never overwritten. Rewording Dutch that has
 * shipped is an update-nl-* catalogue, not an edit here.
 *
 * The files are read from the TREE: tree path i18n/defaults/nl/ joined over
 * every root (server/ and each modules/<id>/server/, see server/moduleRoots.cjs),
 * so a module that owns a namespace keeps its Dutch file in its own root, and a
 * file whose module is absent (or hidden in core mode) is not read. A `dir`
 * argument reads that one directory instead (tests).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { listTreeDir } = require('../../../moduleRoots.cjs');
const { isNamespaceName } = require('../namespaceName.js');

const NL_DIR = __dirname;
/** Tree path of the Dutch data files. */
const NL_TREE_DIR = 'i18n/defaults/nl';

/** @typedef {{ name: string, abs: string, moduleId?: string | null }} DataFile */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The entries to read: the tree directory over all roots, or one directory.
 * @param {string} [dir]
 * @returns {DataFile[]} sorted by name
 */
function entriesOf(dir) {
    if (dir === undefined) return listTreeDir(NL_TREE_DIR);
    return fs.readdirSync(dir).sort().map((name) => ({ name, abs: path.join(dir, name) }));
}

/**
 * The data files, sorted by name. Anything that is neither a data file, this
 * loader nor a test throws: a Dutch file in another shape would be ignored.
 * @param {string} [dir] one directory; the tree directory over all roots when omitted
 * @returns {DataFile[]}
 */
function dataFiles(dir) {
    const out = [];
    for (const entry of entriesOf(dir)) {
        const file = entry.name;
        if (file === 'index.js' || file.endsWith('.test.js')) continue;
        const ns = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
        if (!isNamespaceName(ns)) {
            const where = entry.moduleId ? `i18n/defaults/nl/ of module "${entry.moduleId}"` : 'server/i18n/defaults/nl/';
            throw new Error(`i18n: ${file} in ${where} is not a namespace data file (name it <namespace>.json)`);
        }
        out.push(entry);
    }
    return out;
}

/**
 * The names of the data files, sorted.
 * @param {string} [dir] one directory; the tree directory over all roots when omitted
 * @returns {string[]} file names
 */
function listFiles(dir) {
    return dataFiles(dir).map((entry) => entry.name);
}

/**
 * One file, checked: its shape, and that every key is in its namespace.
 * @param {string} ns
 * @param {unknown} data
 * @returns {{ translations: Record<string, string>, sameAsEnglish: string[] }}
 */
function checkFile(ns, data) {
    const where = `server/i18n/defaults/nl/${ns}.json`;
    if (!isPlainObject(data) || !isPlainObject(data.translations) || !Array.isArray(data.sameAsEnglish)) {
        throw new Error(`i18n: ${where} must be { "translations": {…}, "sameAsEnglish": […] }`);
    }
    const prefix = `${ns}.`;
    /** @type {Record<string, string>} */
    const translations = {};
    for (const [key, value] of Object.entries(data.translations)) {
        if (!key.startsWith(prefix)) throw new Error(`i18n: key "${key}" is in ${where} but not in namespace "${ns}"`);
        if (typeof value !== 'string' || !value.trim()) throw new Error(`i18n: key "${key}" in ${where} has no Dutch text`);
        translations[key] = value;
    }
    /** @type {string[]} */
    const sameAsEnglish = [];
    for (const key of data.sameAsEnglish) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) throw new Error(`i18n: sameAsEnglish entry "${String(key)}" in ${where} is not a key of namespace "${ns}"`);
        if (Object.prototype.hasOwnProperty.call(translations, key)) throw new Error(`i18n: key "${key}" in ${where} is both translated and declared the same as English`);
        sameAsEnglish.push(key);
    }
    return { translations, sameAsEnglish };
}

/**
 * Every data file, merged in file-name order.
 * @param {string} [dir] one directory; the tree directory over all roots when omitted
 * @returns {{ translations: Record<string, string>, sameAsEnglish: string[], namespaces: string[] }}
 */
function loadNamespaceFiles(dir) {
    /** @type {Record<string, string>} */
    const translations = {};
    /** @type {string[]} */
    const sameAsEnglish = [];
    /** @type {string[]} */
    const namespaces = [];
    for (const entry of dataFiles(dir)) {
        const ns = entry.name.slice(0, -'.json'.length);
        const one = checkFile(ns, JSON.parse(fs.readFileSync(entry.abs, 'utf8')));
        Object.assign(translations, one.translations);
        sameAsEnglish.push(...one.sameAsEnglish);
        namespaces.push(ns);
    }
    return { translations, sameAsEnglish, namespaces };
}

/**
 * sha256 over this loader and every data file (name and bytes). The boot
 * ladder adds it to the catalogue's checksum, so a new or changed file makes
 * the catalogue run again on the next boot. A file is hashed by its name, not
 * by the root it lies in: moving it to a module does not change the hash.
 * @param {string} [dir] one directory; the tree directory over all roots when omitted
 * @returns {string}
 */
function sourceHash(dir) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(__filename));
    for (const entry of dataFiles(dir)) {
        hash.update(`\0${entry.name}\0`);
        hash.update(fs.readFileSync(entry.abs));
    }
    return hash.digest('hex');
}

module.exports = { NL_DIR, listFiles, loadNamespaceFiles, sourceHash };

// @typecheck strict
'use strict';
/**
 * The i18n namespaces of first-party modules that are not here, for the Dutch catalogues.
 *
 * A catalogue of the core (migrations/add-nl-*, update-nl-*) may hold keys of several
 * namespaces, some of them a module's. With that module absent its English is not in the
 * dictionary (i18n/defaults/en/index.js skips a namespace whose file is not in the tree), so
 * seeding its Dutch would write strings for a feature this installation does not have. Every
 * catalogue writes through stores/languageStore.js (addMissingGUITranslations,
 * mutateGUITranslations), and that is the one place that asks this file: a key of an absent
 * module's namespace is neither added, changed nor removed. With every module present nothing
 * is absent and every write goes through unchanged.
 *
 * "Absent" is the dictionary's own answer: a namespace that moduleNamespaces.json gives to a
 * module and whose English file is not in the tree (core mode hides it, or the module is not
 * installed). A namespace no module owns is never absent here, whether or not it has a file.
 *
 * A catalogue that ran while a module was absent left that module's keys out, so the ladder
 * must run it again once the module is here: absentNamespacesSalt() goes into the ledger
 * checksum of the Dutch catalogues (boot/bootMigrations.js runNlTranslations). It is empty
 * with every module present, so the checksums stay what they have always been.
 */

const RECORD = require('./moduleNamespaces.json');

/** @type {Readonly<Record<string, string>>} namespace -> module id */
const MODULE_NAMESPACES = Object.freeze({ ...RECORD.namespaces });

/**
 * The module namespaces whose English file is not in the tree.
 * @returns {Set<string>}
 */
function absentNamespaces() {
    const en = require('./en');
    const present = new Set([...en.LISTED_NAMESPACES, ...en.DISCOVERED_NAMESPACES]);
    return new Set(Object.keys(MODULE_NAMESPACES).filter((ns) => !present.has(ns)));
}

/**
 * The translations without the keys of an absent module's namespace (the same object when none is absent).
 * @template {Record<string, unknown>} T
 * @param {T} translations
 * @returns {T}
 */
function presentOnly(translations) {
    const absent = absentNamespaces();
    if (absent.size === 0) return translations;
    return /** @type {T} */ (Object.fromEntries(Object.entries(translations).filter(([key]) => !absent.has(key.split('.')[0]))));
}

/**
 * `next` with every key of an absent module's namespace put back as it is in `current`: a
 * mutator may not add, change or remove such a key.
 * @param {Record<string, string>} current
 * @param {Record<string, string>} next
 * @returns {Record<string, string>}
 */
function keepAbsentNamespaces(current, next) {
    const absent = absentNamespaces();
    if (absent.size === 0) return next;
    const isAbsent = (/** @type {string} */ key) => absent.has(key.split('.')[0]);
    /** @type {Record<string, string>} */
    const out = Object.fromEntries(Object.entries(next).filter(([key]) => !isAbsent(key)));
    for (const [key, value] of Object.entries(current)) if (isAbsent(key)) out[key] = value;
    return out;
}

/**
 * What the ledger checksum of a Dutch catalogue also covers: '' with every module namespace
 * present, else the absent ones, so the catalogue runs again when that set changes.
 * @returns {string}
 */
function absentNamespacesSalt() {
    const absent = [...absentNamespaces()].sort();
    return absent.length === 0 ? '' : `absent-i18n-namespaces:${absent.join(',')}`;
}

module.exports = { MODULE_NAMESPACES, absentNamespaces, presentOnly, keepAbsentNamespaces, absentNamespacesSalt };

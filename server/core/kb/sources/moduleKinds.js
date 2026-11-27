// @typecheck strict
/**
 * The knowledge-source kinds whose code lives in a first-party module.
 *
 * Knowledge bases are core; three of their source kinds are not. A web page is the
 * `webpages` module's adapter, a datatable the `datatables` module's (the engine has no code
 * for those kinds without their module), and a meeting tag is a core adapter
 * that reads the meetings of `meetingNotes` (it asks for that store where it reads it, and a
 * test may hand in its own). Each kind names the one file the core asks for by name
 * (core/featureModules.js): when that answers "absent", the kind is not here.
 *
 * A cloud folder is a core adapter over a storage layer that is the `datatables` module's
 * (the spreadsheet mirror's providers). It asks for that layer where it uses it
 * (cloudFolder.mts, routes/knowledgeBases/cloudAccess.js), so without the module its
 * create, browse and refresh end in the same module_absent refusal.
 *
 * What "not here" means for a kind (the decision of step 1.4):
 *   - a stored source of that kind stays stored and listed;
 *   - its refresh fails with this module_absent error, so the source shows the state every
 *     source that could not refresh shows (status `error` with the sentence), keeps its
 *     schedule, and refreshes again on its next due pass once the module is back;
 *   - creating one answers 409 module_absent.
 */

'use strict';

const { optionalFeatureModule } = require('../../featureModules');
const { HttpError } = require('../../http/errors');

/**
 * @typedef {import('../../featureModules').FeatureModuleMap} FeatureModuleMap
 * @typedef {{ moduleId: string, name: keyof FeatureModuleMap }} KindModule
 */

/** @type {Readonly<Record<string, KindModule>>} */
const KIND_MODULES = Object.freeze({
    webpage: { moduleId: 'webpages', name: 'core/kb/sources/webpage' },
    meeting_tag: { moduleId: 'meetingNotes', name: 'stores/transcriptionStore' },
    datatable: { moduleId: 'datatables', name: 'core/kb/sources/datatable' },
});

/**
 * The refusal for something that needs a module this server does not have.
 * @param {string} moduleId
 * @param {string} what  the subject of the sentence, e.g. 'A datatable source'
 */
function moduleAbsentError(moduleId, what) {
    return new HttpError(409, 'module_absent', `${what} needs the "${moduleId}" module, which is not installed on this server.`);
}

/**
 * The module of a source kind that is not here, or null (a core kind, an unknown kind, or
 * a kind whose module is loaded). A module that failed to load throws (ModuleFailedError).
 * @param {string} kind
 * @returns {string | null}
 */
function absentModuleOf(kind) {
    const entry = Object.hasOwn(KIND_MODULES, kind) ? KIND_MODULES[kind] : null;
    if (!entry) return null;
    return optionalFeatureModule(entry.name) ? null : entry.moduleId;
}

/**
 * The 409 for a source kind whose module is not here.
 * @param {string} kind
 */
function kindAbsentError(kind) {
    const entry = KIND_MODULES[kind];
    return moduleAbsentError(entry ? entry.moduleId : 'unknown', `A source of kind "${kind}"`);
}

/**
 * Refuse a source kind whose module is not here (409 module_absent); nothing for any other kind.
 * @param {string} kind
 */
function assertKindPresent(kind) {
    if (absentModuleOf(kind)) throw kindAbsentError(kind);
}

/**
 * A module's file by name, or the module_absent refusal.
 * @template {keyof FeatureModuleMap} K
 * @param {K} name
 * @param {string} moduleId
 * @param {string} what
 * @returns {NonNullable<FeatureModuleMap[K]>}
 */
function moduleFile(name, moduleId, what) {
    const mod = optionalFeatureModule(name);
    if (!mod) throw moduleAbsentError(moduleId, what);
    return /** @type {NonNullable<FeatureModuleMap[K]>} */ (mod);
}

module.exports = { KIND_MODULES, absentModuleOf, assertKindPresent, kindAbsentError, moduleAbsentError, moduleFile };

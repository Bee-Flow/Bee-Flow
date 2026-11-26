// @typecheck strict
/**
 * First-party module state: which module provides which registry name, and
 * whether that module is loaded, failed, or absent.
 *
 * Core reaches feature code through three name registries
 * (core/featureModules.js, core/integrations/integrationClients.js,
 * core/automationRunner/featurePorts.js). Once a first-party module can be
 * absent, core needs a lookup that answers "not here" (the optional* lookups
 * in those registries). A module that is installed but failed to load must
 * never look absent: erasure, retention and encryption code would then skip
 * data that exists. So the loader declares, from each module's manifest and
 * BEFORE its code runs, which names it will register (declareProvides), then
 * records the outcome (setModuleState). An optional lookup that finds no
 * registration asks assertProviderNotFailed first, which throws when the
 * declared provider failed.
 *
 * Dependency-free (node:* only): it is loaded very early, before the loader.
 * In-memory and per process, like the registries it backs.
 */

'use strict';

/** @typedef {'featureModules' | 'integrationClients' | 'runnerPorts'} ProvideKind */
/** @typedef {'absent' | 'loaded' | 'failed'} ModuleState */
/** @typedef {{ featureModules?: string[], integrationClients?: string[], runnerPorts?: string[] }} Provides */

/** @type {readonly ProvideKind[]} */
const KINDS = Object.freeze(['featureModules', 'integrationClients', 'runnerPorts']);

/** kind -> (name -> moduleId) */
/** @type {Map<ProvideKind, Map<string, string>>} */
const providers = new Map(KINDS.map((kind) => [kind, new Map()]));

/** moduleId -> { state, detail } */
/** @type {Map<string, { state: 'loaded' | 'failed', detail: string | undefined }>} */
const states = new Map();

/** Thrown when core asks for a name whose declared provider failed to load. */
class ModuleFailedError extends Error {
    /**
     * @param {string} moduleId
     * @param {ProvideKind} kind
     * @param {string} name
     * @param {string | undefined} detail
     */
    constructor(moduleId, kind, name, detail) {
        super(`module "${moduleId}" failed to load, so ${kind} "${name}" is unavailable${detail ? `: ${detail}` : ''}`);
        this.name = 'ModuleFailedError';
        this.code = 'MODULE_FAILED';
        this.moduleId = moduleId;
        this.kind = kind;
        this.detail = detail;
    }
}

/**
 * @param {string} kind
 * @returns {Map<string, string>}
 */
function providerMap(kind) {
    const map = providers.get(/** @type {ProvideKind} */ (kind));
    if (!map) throw new TypeError(`moduleState: unknown kind "${kind}" (one of ${KINDS.join(', ')})`);
    return map;
}

/** @param {string} moduleId */
function checkModuleId(moduleId) {
    if (typeof moduleId !== 'string' || moduleId === '') throw new TypeError('moduleState: a module id is a non-empty string');
}

/**
 * The names a module will register, from its manifest. Declaring a module
 * again replaces its earlier declaration; a name another module already
 * provides is refused (a name has exactly one provider).
 * @param {string} moduleId
 * @param {Provides} provides
 */
function declareProvides(moduleId, provides) {
    checkModuleId(moduleId);
    const entries = KINDS.map((kind) => /** @type {const} */ ([kind, provides?.[kind] ?? []]));
    for (const [kind, names] of entries) {
        for (const name of names) {
            const owner = providerMap(kind).get(name);
            if (owner !== undefined && owner !== moduleId) {
                throw new Error(`moduleState: ${kind} "${name}" is declared by "${owner}" and "${moduleId}"`);
            }
        }
    }
    for (const map of providers.values()) {
        for (const [name, owner] of map) if (owner === moduleId) map.delete(name);
    }
    for (const [kind, names] of entries) {
        for (const name of names) providerMap(kind).set(name, moduleId);
    }
}

/**
 * Record a module's load outcome.
 * @param {string} moduleId
 * @param {'loaded' | 'failed'} state
 * @param {string} [detail]
 */
function setModuleState(moduleId, state, detail) {
    checkModuleId(moduleId);
    if (state !== 'loaded' && state !== 'failed') throw new TypeError(`moduleState: state is 'loaded' or 'failed', not "${state}"`);
    states.set(moduleId, { state, detail });
}

/**
 * @param {string} moduleId
 * @returns {ModuleState}
 */
function moduleStateOf(moduleId) {
    return states.get(moduleId)?.state ?? 'absent';
}

/**
 * The module that declared this name, or null.
 * @param {ProvideKind} kind
 * @param {string} name
 * @returns {string | null}
 */
function providerOf(kind, name) {
    return providerMap(kind).get(name) ?? null;
}

/**
 * Throw a ModuleFailedError when the declared provider of this name failed to
 * load; do nothing when there is no provider or it is not failed.
 * @param {ProvideKind} kind
 * @param {string} name
 */
function assertProviderNotFailed(kind, name) {
    const moduleId = providerOf(kind, name);
    if (moduleId === null) return;
    const entry = states.get(moduleId);
    if (entry?.state === 'failed') throw new ModuleFailedError(moduleId, kind, name, entry.detail);
}

/** Test seam: forget every declaration and state. */
function _resetModuleStateForTests() {
    for (const map of providers.values()) map.clear();
    states.clear();
}

module.exports = {
    ModuleFailedError,
    declareProvides,
    setModuleState,
    moduleStateOf,
    providerOf,
    assertProviderNotFailed,
    _resetModuleStateForTests,
};

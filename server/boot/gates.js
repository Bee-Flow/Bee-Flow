// @typecheck strict
'use strict';
/**
 * The gate factories the core hands to every first-party mount row
 * (modules/firstParty/contract.js Gates, loader.mount(app, gates, slot)), and that
 * index.js uses for its own mounts. One object, built once.
 *
 * Every member is a getter that requires its file on first use, so building the object loads
 * nothing: each file is loaded when the first mount asks for its gate.
 *
 * requireTraining belongs to module learning (learning/requireTraining.js), and the core
 * applies it to its own mounts too (/agents, /api/kb, /api/skills). With learning present it is
 * exactly the function learning exports; without it, a factory whose middleware lets every
 * request through (no course can be required when the Learning Center is not there).
 */

const { optionalModuleFile } = require('./optionalModuleFile');

/** @typedef {import('../modules/firstParty/contract').Gates} Gates */
/** @typedef {import('express').RequestHandler} RequestHandler */

/** @type {RequestHandler} */
const noTrainingRequired = (_req, _res, next) => next();

/**
 * learning's requireTraining, or a pass-through factory when module learning is absent.
 * @returns {(area: string) => RequestHandler}
 */
function requireTrainingOrPassThrough() {
    const learning = optionalModuleFile(() => require('../learning/requireTraining'));
    return learning ? learning.requireTraining : () => noTrainingRequired;
}

/** @type {Gates | null} */
let gates = null;

/** @returns {Gates} */
function buildGates() {
    return {
        get requireModule() { return require('../modules').requireModule; },
        get requireCapability() { return require('../core/entitlements/entitlements').requireCapability; },
        get requireLicenseFeature() { return require('../license/middleware').requireFeature; },
        get requireTraining() { return requireTrainingOrPassThrough(); },
        get requireAuthedUser() { return require('../auth').requireAuth; },
        get requireAnyPermission() { return require('../auth/permissions').requireAnyPermission; },
        get featureGate() { return require('./featureGate').featureGate; },
        get googleSessionHydration() { return require('../auth/googleSessionHydration').googleSessionHydration; },
        get microsoftSessionHydration() { return require('../auth/microsoftSessionHydration').microsoftSessionHydration; },
    };
}

/** @returns {Gates} the one gates object */
function getGates() {
    if (!gates) gates = buildGates();
    return gates;
}

module.exports = { getGates };

// @typecheck
/**
 * The dependencies of the stepEditing/ modules that live inside the server's
 * largest import cycle (stepBuilders/index and aiStep, inspection,
 * documentDiscovery). The stepEditing.js barrel, which sits in that cycle
 * anyway, fills this object at load with GETTERS that require at call time
 * (documentDiscovery as a function, the lazy require the single file had);
 * the modules read it at call time. That keeps the split modules out
 * of the cycle (scc-ratchet), the same ctx pattern as automation/triggerBus.js.
 *
 * This module imports nothing. Never destructure it at module top: the barrel
 * fills it after the modules are loaded.
 */

/**
 * @typedef {{
 *   ADD_FOR_TYPE: typeof import('../stepBuilders').ADD_FOR_TYPE,
 *   modelTierGateError: typeof import('../stepBuilders').modelTierGateError,
 *   sanitizeAgentId: typeof import('../stepBuilders').sanitizeAgentId,
 *   sanitizeSkillIds: typeof import('../stepBuilders').sanitizeSkillIds,
 *   sanitizeAgentPermissions: typeof import('../stepBuilders').sanitizeAgentPermissions,
 *   sanitizeDisabledAgentSkillIds: typeof import('../stepBuilders').sanitizeDisabledAgentSkillIds,
 *   agentPermissionsBlock: typeof import('../stepBuilders').agentPermissionsBlock,
 *   inspectGateError: typeof import('../inspection').inspectGateError,
 *   documentDiscovery: () => typeof import('../../../core/documents/documentDiscovery'),
 * }} CycleDeps
 */

// Empty at load; the stepEditing.js barrel defines every CycleDeps member
// before any split module reads one, which is why the type is the full shape.
module.exports = /** @type {CycleDeps} */ (/** @type {unknown} */ ({}));

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

module.exports = {};

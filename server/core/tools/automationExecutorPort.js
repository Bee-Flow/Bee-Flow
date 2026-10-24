// @typecheck
/**
 * The one capability core/tools needs from the automation runner: start a
 * run. A skill linked to an automation (skillInjection.js) executes it, but
 * the runner itself dispatches tools through core/tools, so requiring the
 * runner from here closed an import cycle of two dozen files.
 *
 * automationRunner.js registers `executeAutomation` when it loads (boot loads
 * it); this file imports nothing, so it can sit under both sides. Until the
 * runner is loaded, `getAutomationExecutor()` is null and a skill's linked
 * automation is skipped, as it was when the runner could not be required.
 */

'use strict';

let executor = null;

/** @param {((automation: object, opts: object) => Promise<any>) | null} fn */
function setAutomationExecutor(fn) {
    executor = typeof fn === 'function' ? fn : null;
}

function getAutomationExecutor() {
    return executor;
}

module.exports = { setAutomationExecutor, getAutomationExecutor };

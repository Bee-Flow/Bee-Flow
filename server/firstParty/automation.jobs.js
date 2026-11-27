// @typecheck strict
/**
 * The startup job and the shutdown drain of the first-party module "automation" (part "jobs"
 * of firstParty/automation.js; contract in modules/firstParty/contract.js). Moved verbatim out
 * of boot/startupJobs.js and boot/lifecycle.js: the runner starts in the same phase through
 * loader.runStartupPhase, which logs a throw as '[Server] Automation runner load failed:' like
 * the old catch did; the drain runs inside loader.drain, next to the other modules' drains.
 *
 * The meeting-import passes ride on this runner's scheduler through a runner port; they are
 * not rows of their own.
 */

'use strict';

const log = require('../telemetry/log');

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // Initialize Automation Runner — gated per-org by the 'automations' beta feature
    { key: 'automation:runner', phase: 'startRunnersAndFeeds', label: 'Automation runner',
        start: () => {
            const automationRunner = require('../core/automationRunner');
            automationRunner.start().catch((/** @type {Error} */ err) =>
                log.warn('[Server] Automation runner start error:', err.message),
            );
        } },
];

/**
 * Drain in-flight automation runs: stop claiming new scheduled work and wait (bounded) for
 * running executions to finish, so a deploy doesn't abandon a run mid-step and re-fire its side
 * effects after restart. Bounded by the shared drain budget (AUTOMATION_DRAIN_TIMEOUT_MS, read
 * by boot/lifecycle.js), under the orchestrator's termination grace (k8s default 30s).
 * @param {{ timeoutMs: number }} opts
 */
async function drain({ timeoutMs }) {
    try {
        const automationRunner = require('../core/automationRunner');
        if (typeof automationRunner.stop === 'function') {
            await automationRunner.stop({ timeoutMs });
        }
    } catch (e) { log.warn('[Server] automation runner drain failed:', /** @type {Error} */ (e).message); }
}

module.exports = { jobs, drain };

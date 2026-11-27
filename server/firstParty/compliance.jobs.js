// @typecheck strict
/**
 * The startup jobs of the first-party module "compliance" (part "jobs" of firstParty/compliance.js;
 * contract in modules/firstParty/contract.js). Moved out of boot/startupJobs.js, started by
 * loader.runStartupPhase in the same phase.
 *
 * One deliberate change: the block had no try/catch in boot/, so a throw aborted the boot. As a
 * row it is fail-soft like every other job (logged as '[Server] Compliance jobs start failed:'):
 * a broken module must not take the core down.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // Register and schedule AI Act + GDPR compliance checks (6-hour interval,
    // multi-tenant), and the daily statutory-deadline notifier (72h incidents /
    // 30d DSRs / DPIA expiries). One row, as it was one block: a throw stops the ones after it.
    { key: 'compliance:checks', phase: 'startRetentionAndComplianceJobs', label: 'Compliance jobs', failText: 'start failed',
        start: () => {
            require('../compliance/checks');
            require('../compliance/scheduler').start();
            require('../jobs/complianceDeadlineNotifier').start();
            // ISO evidence connectors — periodic external-system sweeps (advisory-locked).
            require('../compliance/isoEvidenceCollector').start();
        } },
];

module.exports = { jobs };

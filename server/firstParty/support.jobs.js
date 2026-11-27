// @typecheck strict
/**
 * The startup jobs of the first-party module "support" (part "jobs" of firstParty/support.js;
 * contract in modules/firstParty/contract.js). Moved verbatim out of boot/startupJobs.js: one
 * row per try block there, started by loader.runStartupPhase in the same phase, which logs a
 * throw as '[Server] <label> load failed:' like the old catch did. The isModuleAvailable('support')
 * guards went: an absent module contributes no row. The tick itself still re-checks the runtime
 * module row.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // Support Studio inbox sync — polls connected tenant mailboxes and turns
    // inbound email into support tickets. Set SUPPORT_INBOX_SYNC_IN_API=false
    // when a dedicated worker owns it.
    { key: 'support:inboxSync', phase: 'startSupportAndSyncJobs', label: 'Support inbox sync engine',
        start: () => {
            if (process.env.SUPPORT_INBOX_SYNC_IN_API !== 'false') {
                require('../services/supportInboxSyncEngine').startSupportInboxSync();
            }
        } },
    // Support Studio historical-scan drain — runs on-demand "how fast did we
    // answer in the past?" scans queued from the Insights view. Aggregate-only,
    // off the sync tick. Set SUPPORT_SCAN_IN_API=false when a worker owns it.
    { key: 'support:inboxScan', phase: 'startSupportAndSyncJobs', label: 'Support inbox scan engine',
        start: () => {
            if (process.env.SUPPORT_SCAN_IN_API !== 'false') {
                require('../services/supportInboxScanEngine').startSupportInboxScan();
            }
        } },
    // Customer Support SLA enforcer — policy-driven first-response/resolution
    // breach detection on a 60s tick (replaces the old 15-min at-risk warner).
    // One row with the issue sync, as it was one try block: a throw stops both.
    { key: 'support:slaEnforcer', phase: 'startSupportAndSyncJobs', label: 'Support SLA enforcer',
        start: () => {
            require('../services/supportSlaEnforcer').start();
            require('../services/supportIssueSync').start();
        } },
];

module.exports = { jobs };

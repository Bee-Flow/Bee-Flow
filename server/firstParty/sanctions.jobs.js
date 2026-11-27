// @typecheck strict
/**
 * The startup jobs of the first-party module "sanctions" (part "jobs" of firstParty/sanctions.js;
 * contract in modules/firstParty/contract.js). Moved verbatim out of boot/startupJobs.js,
 * started by loader.runStartupPhase in the same phase, which logs a throw as
 * '[Server] <label> load failed:' like the old catch did.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // The public sanctions lists (EU, UN, NL, OFAC, UK): daily, only while an organisation has the
    // integration on (SANCTIONS_REFRESH_INTERVAL_HOURS, 0 = off). Advisory-locked across pods.
    { key: 'sanctions:listRefresh', phase: 'startSupportAndSyncJobs', label: 'Sanctions list refresh',
        start: () => { require('../jobs/sanctionsListRefresh.mts').start(); } },
];

module.exports = { jobs };

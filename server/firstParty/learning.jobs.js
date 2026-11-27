// @typecheck strict
/**
 * The startup jobs of the first-party module "learning" (part "jobs" of firstParty/learning.js;
 * contract in modules/firstParty/contract.js). Moved verbatim out of boot/startupJobs.js: one
 * row per try block there, started by loader.runStartupPhase in the same phase, which logs a
 * throw as '[Server] <label> load failed:' like the old catch did.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // Learning Center review nudge — daily tick that reminds lapsed learners
    // (started, unfinished, quiet 7-60d) to do a short review. Max one nudge
    // per user per 14d via configStore marker; advisory-locked across pods.
    // Learning-owned, so it follows the module switch like its siblings
    // (an absent module contributes no row).
    { key: 'learning:nudge', phase: 'startSupportAndSyncJobs', label: 'Learning nudge',
        start: () => { require('../jobs/learningNudge').start(); } },
    // Learning Center videos: install the pack this release pins into
    // LEARN_MEDIA_DIR, ~15 s after boot and never blocking it. Off in tests and
    // with LEARN_MEDIA_AUTO=off; a build without a pin skips quietly.
    { key: 'learning:mediaSync', phase: 'startSupportAndSyncJobs', label: 'Learn media sync',
        start: () => { require('../learning/learnMediaSync').startLearnMediaSync(); } },
];

module.exports = { jobs };

// @typecheck strict
/**
 * The startup jobs of the first-party module "projects" (part "jobs" of firstParty/projects.js;
 * contract in modules/firstParty/contract.js). Moved verbatim out of boot/startupJobs.js: one
 * row per try block there, started by loader.runStartupPhase in the same phase, which logs a
 * throw as '[Server] <label> load failed:' like the old catch did. The isModuleAvailable('projects')
 * guards went: an absent module contributes no row.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // The AI that joins team chats and comment threads by itself: every 5 s
    // it claims the debounced watches that came due (FOR UPDATE SKIP LOCKED,
    // so replicas share the work without an advisory lock), asks the fast
    // relevance gate and answers or stays silent. A few at a time per replica,
    // paused by its own circuit breaker when the gate keeps failing.
    { key: 'projects:aiParticipation', phase: 'startRunnersAndFeeds', label: 'AI participation job',
        start: () => { require('../projects/participation/aiParticipationJob').start(); } },
    // Project task reminders: a daily tick for open tasks due tomorrow, today or late.
    { key: 'projects:taskDueNotifier', phase: 'startSupportAndSyncJobs', label: 'Project task due notifier',
        start: () => { require('../projects/taskDueNotifier').start(); } },
    { key: 'projects:deployRunner', phase: 'startSupportAndSyncJobs', label: 'Solution deploy runner',
        start: () => { require('../projects/stages/deployRunnerJob').start(); } },
];

module.exports = { jobs };

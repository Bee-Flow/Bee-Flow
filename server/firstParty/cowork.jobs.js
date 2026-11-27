// @typecheck strict
/**
 * The startup jobs of the first-party module "cowork" (part "jobs" of firstParty/cowork.js;
 * contract in modules/firstParty/contract.js). Moved verbatim out of boot/startupJobs.js: one
 * row per try block there, started by loader.runStartupPhase in the same phase, which logs a
 * throw as '[Server] <label> <failText>:' like the old catch did.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // The cowork tick (the one scheduler of cowork runs) with its retention sweep, and the
    // coverage prune of aiTaskRunner, its execution engine. Each is armed here and not when
    // its module is required: a script, a generator or a test that loads the app runs no job
    // against the database it happens to point at.
    { key: 'cowork:runner', phase: 'startModuleSchedulers', label: 'Cowork runner', failText: 'start failed',
        start: () => { require('../core/cowork/coworkRunner').start(); } },
    { key: 'cowork:coveragePrune', phase: 'startModuleSchedulers', label: 'Cowork coverage prune', failText: 'start failed',
        start: () => { require('../core/aiTaskRunner').start(); } },
    // Coworks that start after another one hear the runs that end (core/cowork/afterCowork.mts).
    { key: 'cowork:afterCowork', phase: 'startSupportAndSyncJobs', label: 'Cowork after-cowork', failText: 'start failed',
        start: () => { require('../core/cowork/afterCowork.mts').start(); } },
    // Every closed Cowork run gets a signed receipt (core/cowork/receipts/issueReceipts.mts).
    { key: 'cowork:receipts', phase: 'startSupportAndSyncJobs', label: 'Cowork receipts', failText: 'start failed',
        start: () => { require('../core/cowork/receipts/issueReceipts.mts').start(); } },
    // "It notices what you repeat" forgets, daily, notes over eight weeks old and every note of a person who is off or not allowed (core/cowork/habits/habitSweep.mts).
    { key: 'cowork:habitSweep', phase: 'startSupportAndSyncJobs', label: 'Cowork habit sweep', failText: 'start failed',
        start: () => { require('../core/cowork/habits/habitSweep.mts').start(); } },
    // A cowork with a goal is measured by its approved check after its runs (core/cowork/goals/goalMeasure.mts).
    { key: 'cowork:goalMeasure', phase: 'startSupportAndSyncJobs', label: 'Cowork goal measuring', failText: 'start failed',
        start: () => { require('../core/cowork/goals/goalMeasure.mts').start(); } },
    // A plan that keeps failing, or a goal that stays under target, gets a repair proposed (never applied); the work is in usecases/.
    { key: 'cowork:repairs', phase: 'startSupportAndSyncJobs', label: 'Cowork repairs', failText: 'start failed',
        start: () => { require('../core/cowork/repairs/repairTriggers.mts').start((item, trigger) => require('../usecases/coworkProposals.mts').proposeRepair(item, trigger)); } },
    // A run that did not do its work because a step read a list that is not there gets that reference fixed by itself,
    // when the fix reaches exactly what the plan reaches and a replay proves it (decision 0050); the work is in usecases/.
    { key: 'cowork:autoResolve', phase: 'startSupportAndSyncJobs', label: 'Cowork auto-fix', failText: 'start failed',
        start: () => { require('../core/cowork/repairs/autoResolve.mts').start((item, run, fact) => require('../usecases/coworkAutoResolve.mts').autoResolve(item, run, fact)); } },
    // Weekly: a steady AI step is offered as a fixed one when a replay proves it (core/cowork/cheaper/stableSteps.mts).
    { key: 'cowork:stableSteps', phase: 'startSupportAndSyncJobs', label: 'Cowork steady-step offers', failText: 'start failed',
        start: () => { require('../core/cowork/cheaper/stableSteps.mts').start((item, step) => require('../usecases/coworkProposals.mts').offerFixedStep(item, step)); } },
    // The daily Cowork e-mail of what waits for its owner (off until the owner switches it on); the list is composed in usecases/.
    { key: 'cowork:dailyMail', phase: 'startSupportAndSyncJobs', label: 'Cowork daily mail',
        start: () => { require('../jobs/coworkDailyMail.mts').start((userId) => require('../usecases/coworkNeedsYou.mts').needsYou(userId)); } },
];

module.exports = { jobs };

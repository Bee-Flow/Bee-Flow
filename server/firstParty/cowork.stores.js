// @typecheck strict
/**
 * The store schemas and loose migrations of the module "cowork" (part of
 * firstParty/cowork.js, see modules/firstParty/parts.js). The rows were the
 * module's entries of storeModules.js STORE_MODULES and boot/bootMigrations.js
 * LOOSE_MIGRATIONS; their order stays the core's (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'aiTaskStore', file: './stores/aiTaskStore' },
    // Owns cowork-2026-08 (cowork_schedules + cowork_runs). Without it here a
    // standalone `npm run db:migrate` never created those tables — they only
    // appeared once the app booted and something required the store.
    { name: 'coworkStore', file: './stores/coworkStore' },
    // Whether an owner gets the daily Cowork e-mail, and the day it was last sent (cowork_daily_mail). No FKs.
    { name: 'coworkDailyMailStore', file: './stores/coworkDailyMail.mts' },
    // The run receipts of Cowork items (cowork_receipts); refers to cowork_schedules, so after coworkStore.
    { name: 'coworkReceiptsStore', file: './stores/coworkReceipts.mts' },
    // What a person repeats in chat, as hashes and weeks, when they switched it on (cowork_habit_signals, _offers). No FKs.
    { name: 'coworkHabitsStore', file: './stores/coworkHabits.mts' },
    // The replays of Cowork plans (cowork_replays, cowork_replay_events); refers to cowork_schedules, so after coworkStore.
    { name: 'coworkReplaysStore', file: './stores/coworkReplays.mts' },
    // The goals of Cowork items and what their checks measured (cowork_goals, cowork_goal_results); refer to
    // cowork_schedules, so after coworkStore.
    { name: 'coworkGoalsStore', file: './stores/coworkGoals.mts' },
    // Desks of coworks of different owners (cowork_desks, cowork_desk_members, cowork_desk_roles, cowork_desk_follows); refer to
    // cowork_schedules, so after coworkStore.
    { name: 'coworkDesksStore', file: './stores/coworkDesks.mts' },
    // What Cowork proposes to change in a plan, and when it last tried (cowork_proposals, cowork_proposal_attempts);
    // refer to cowork_schedules, so after coworkStore.
    { name: 'coworkProposalsStore', file: './stores/coworkProposals.mts' },
    // Cowork templates of an organisation (cowork_templates, stores/ddl/cowork-templates-2026-11.js). No FKs.
    { name: 'coworkTemplatesStore', file: './stores/coworkTemplates.mts' },
];

/** @type {string[]} */
const migrations = [
    // Moves bare prompt tasks to Cowork; both runners tick every 60s,
    // so the two tables must not stay alive at the same time.
    'prompt-tasks-to-cowork-2026-08',
    // The agent-linked tasks (the old "agent routines") follow: Cowork runs an item as an agent, ai_tasks is unwritten.
    'agent-tasks-to-cowork-2026-10',
    'cowork-conversation-origin-2026-11', // Cowork's own conversations out of the chat history, only where demonstrable
];

module.exports = { stores, migrations };

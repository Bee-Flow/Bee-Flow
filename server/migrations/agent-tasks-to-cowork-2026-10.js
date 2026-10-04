#!/usr/bin/env node
/**
 * Data migration: move the agent-linked rows of `ai_tasks` ("agent routines")
 * into Cowork, the last step of prompt-tasks-to-cowork-2026-08.
 *
 * That migration left these rows behind because Cowork's editor could not run
 * an item as an agent then. It can now (a cowork schedule carries `agent_id`,
 * and aiTaskRunner sends such a schedule down the agent-runtime path), so the
 * two tables no longer hold different things. The move is the same one:
 * copy with ids preserved, seed the one history row, pause the original and
 * stamp it (see moveTasksToCowork). After this nothing writes to `ai_tasks`;
 * the table stays for the history and as the way back.
 *
 * Idempotent through the same `migrated_to_cowork_at` stamp. Auto-runs from
 * server boot. Manual usage:
 *   node server/migrations/agent-tasks-to-cowork-2026-10.js
 */

const { moveTasksToCowork, PLAIN_TASK } = require('./prompt-tasks-to-cowork-2026-08');

const AGENT_TASK = `NOT ${PLAIN_TASK}`;

async function up() {
    return moveTasksToCowork({ where: AGENT_TASK, label: 'agent-tasks-to-cowork-2026-10' });
}

module.exports = { up, AGENT_TASK };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

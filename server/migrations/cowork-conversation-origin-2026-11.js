// @typecheck strict
/**
 * Migration: the conversations Cowork made before a conversation had an origin (2026-11).
 *
 * A Cowork run as an agent writes into a conversation, which until now was an ordinary chat: it showed in the chat
 * list, in the chat search and as "the latest conversation" with that agent. A run's conversation is now marked
 * `agent_conversations.origin = 'cowork'` when it is made (core/agentRuntime/chatStream/turnSetup.js), and the chat
 * lists leave those out. This marks the existing ones, but ONLY when the conversation is demonstrably a Cowork run's.
 * Every condition below must hold; a conversation that fails one is left a chat:
 *
 *   1. a Cowork item points at it (cowork_schedules.conversation_id), with the same agent and the same user;
 *   2. it was created during a run of that item (created_at within 5 minutes after the start of one of its runs):
 *      not an existing chat the item was pointed at later;
 *   3. nothing was written to it after the item's last run (updated_at at most 5 minutes after that run ended);
 *   4. it holds at least one and at most as many user turns as the item has runs (run_count): each run adds one, so
 *      more means a person typed in it;
 *   5. its turns are countable: the message rows (`messages_migrated`), not the old JSON blob, which may be
 *      encrypted and cannot be read here;
 *   6. it is not filed into a project (a person did that).
 *
 * Mail runs started one conversation per mail and the item only points at the newest, so the older ones of a mail
 * item fail condition 1 and stay in the chat history; so do conversations of items whose run history was trimmed.
 * The count of linked conversations left as chats is logged.
 *
 * Idempotent: it only looks at origin IS NULL. On a fresh install (no such tables yet) it has nothing to do.
 */

const { getOne, getAll, exec } = require('../db');

const TABLES = ['agent_conversations', 'cowork_schedules', 'cowork_runs', 'conversation_messages'];

async function tablesExist() {
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM unnest($1::text[]) AS t(name) WHERE to_regclass('public.' || t.name) IS NOT NULL`,
        [TABLES],
    );
    return Number(row?.n) === TABLES.length;
}

async function up() {
    if (!(await tablesExist())) {
        console.log('[Migration] cowork-conversation-origin-2026-11: no Cowork or conversation tables yet, nothing to mark');
        return { marked: 0, kept: 0 };
    }
    // The column belongs to the agent schema (stores/agent/initSchema.base.js); the ladder may come first.
    await exec('ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS origin TEXT');
    const linked = await getAll(
        `SELECT DISTINCT c.id
           FROM agent_conversations c
           JOIN cowork_schedules s ON s.conversation_id = c.id AND s.agent_id = c.agent_id AND s.user_id = c.user_id
          WHERE c.origin IS NULL`,
    );
    const marked = await getAll(
        `UPDATE agent_conversations c
            SET origin = 'cowork'
           FROM cowork_schedules s
          WHERE s.conversation_id = c.id AND s.agent_id = c.agent_id AND s.user_id = c.user_id
            AND c.origin IS NULL
            AND c.project_id IS NULL
            AND c.messages_migrated = TRUE
            AND EXISTS (
                SELECT 1 FROM cowork_runs r
                 WHERE r.schedule_id = s.id
                   AND c.created_at >= r.started_at
                   AND c.created_at <= r.started_at + INTERVAL '5 minutes')
            AND c.updated_at <= (
                SELECT MAX(COALESCE(r.finished_at, r.started_at)) + INTERVAL '5 minutes'
                  FROM cowork_runs r WHERE r.schedule_id = s.id)
            AND (SELECT COUNT(*) FROM conversation_messages m
                  WHERE m.conversation_id = c.id AND m.conversation_type = 'agent' AND m.role = 'user')
                BETWEEN 1 AND COALESCE(s.run_count, 0)
         RETURNING c.id`,
    );
    const result = { marked: marked.length, kept: linked.length - marked.length };
    console.log(`[Migration] cowork-conversation-origin-2026-11: ${result.marked} Cowork conversation(s) marked, ${result.kept} linked one(s) left in the chat history`);
    return result;
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

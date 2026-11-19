/**
 * Where an agent conversation came from (`agent_conversations.origin`, stores/agent/initSchema.base.js): NULL for a
 * chat, 'cowork' for the thread a Cowork run writes into (core/cowork/agentScheduleRun.js). The chat list, the
 * per-agent list, the latest-conversation lookup and the chat search read only origin IS NULL
 * (./agentConversations.js, ../lib/conversationSearch.js); a Cowork conversation is kept and opens by id from its run.
 *
 * Re-exported by ./agentConversations.js, so agentStore keeps one surface.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

// Without an extension: tests swap these modules under exactly these request strings.
const { run, getOne } = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<unknown>; getOne: (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null> };
const { initDB } = nodeRequire('./initSchema') as { initDB: () => Promise<unknown> };

/** A fresh conversation; `origin: 'cowork'` marks a Cowork run's thread, anything else is a chat. */
export async function createNewConversation(agentId: string, userId: string, { origin = null }: { origin?: string | null } = {}) {
    await initDB();
    const id = randomUUID();
    const stored = origin === 'cowork' ? 'cowork' : null;
    await run("INSERT INTO agent_conversations (id, agent_id, user_id, messages_json, origin, created_at, updated_at) VALUES ($1,$2,$3,'[]',$4,NOW(),NOW())", [id, agentId, userId, stored]);
    return { id, agent_id: agentId, user_id: userId, messages: [] as unknown[], origin: stored };
}

/** 'cowork' for the thread of a Cowork run, null for a chat (or no such conversation). One column, nothing decrypted. */
export async function getConversationOrigin(conversationId: string): Promise<string | null> {
    await initDB();
    const row = await getOne('SELECT origin FROM agent_conversations WHERE id = $1', [conversationId]);
    return row && typeof row.origin === 'string' ? row.origin : null;
}

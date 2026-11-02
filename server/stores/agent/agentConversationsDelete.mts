/**
 * agentConversationsDelete.mts: the conversations with one agent, their
 * messages first. conversation_messages has no FK to its conversation, so
 * nothing else removes them. Shared by agent deletion (./agentCrud.js) and
 * organisation deletion (../user/organizations.js).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Run = (sql: string, params?: unknown[]) => Promise<unknown>;

/** Delete the agent's conversations and their messages through the caller's `run`. */
export async function deleteAgentConversations(run: Run, agentId: string): Promise<void> {
    const { isMissingTable } = nodeRequire('../../utils/isMissingTable.js') as { isMissingTable: (e: unknown) => boolean };
    await run('DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE agent_id = $1)', [agentId])
        .catch((e: unknown) => { if (!isMissingTable(e)) throw e; });
    await run('DELETE FROM agent_conversations WHERE agent_id = $1', [agentId]);
}

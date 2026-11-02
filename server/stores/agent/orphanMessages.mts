/**
 * orphanMessages.mts: boot-time sweep of conversation_messages rows whose
 * conversation no longer exists.
 *
 * Every writer of conversation_messages (./conversationMessages.js, through
 * agentConversations, directConversations and conversationTurns) writes for a
 * conversation of type 'agent' (parent agent_conversations) or 'direct'
 * (parent direct_conversations), after reading the parent row. Notebook chats
 * keep their own table. A row whose id is in neither parent table is left
 * behind by a deletion that did not reach the messages (a partial failure, or
 * an erasure from before the messages were deleted with the conversation),
 * and nothing can read it any more.
 *
 * The sweep only runs when all three tables exist: a missing parent table
 * would otherwise make every row look orphaned. Rows of any other type are
 * left alone.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface Db {
    getOne: (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>;
    run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null } | undefined>;
}

const SWEPT_TYPES = ['agent', 'direct'];

/** Delete the orphaned rows; returns how many went. */
export async function purgeOrphanedMessages(db: Db = nodeRequire('../../db.js')): Promise<number> {
    const present = await db.getOne(
        `SELECT to_regclass('conversation_messages') IS NOT NULL AS messages,
                to_regclass('agent_conversations') IS NOT NULL AS agent,
                to_regclass('direct_conversations') IS NOT NULL AS direct`,
    );
    if (!present || present.messages !== true || present.agent !== true || present.direct !== true) return 0;
    const res = await db.run(
        `DELETE FROM conversation_messages m
          WHERE m.conversation_type = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM agent_conversations a WHERE a.id = m.conversation_id)
            AND NOT EXISTS (SELECT 1 FROM direct_conversations d WHERE d.id = m.conversation_id)`,
        [SWEPT_TYPES],
    );
    return res?.rowCount ?? 0;
}

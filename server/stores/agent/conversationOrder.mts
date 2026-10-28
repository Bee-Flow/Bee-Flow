/**
 * The order of a conversation's rows in `conversation_messages`, and the lock
 * that keeps it well-defined. Used by stores/agent/conversationMessages.js.
 *
 * Every reader goes through that store: the chat view (web, the Nextcloud
 * embed, mobile), export, and the history the model gets on the next turn. So
 * this is the one order a conversation has. It never comes from a clock on a
 * client: `seq` is the position the server's writer gave the row.
 */

/**
 * `seq` is unique per conversation as long as writes on one conversation
 * serialise (`lockConversation`), but no unique index guarantees it, and rows
 * written by unserialised writers may share one. On a tie Postgres returns
 * heap order, which an UPDATE of either row flips, so the same conversation
 * could read back differently from one request to the next. `created_at` (the
 * writing transaction's start) and then `id` make the order total and stable.
 */
export const READ_ORDER = 'ORDER BY seq ASC, created_at ASC, id ASC';

interface QueryClient {
    query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Serialise every writer of one conversation's rows on its parent row.
 *
 * Under READ COMMITTED a DELETE does not see rows another transaction
 * committed after the DELETE began. Two unserialised writers on one
 * conversation (two replaces, a replace and an append, the lazy migration and
 * a replace) therefore both keep their own rows, on the same seq numbers.
 * Call it first in the transaction, before any read of conversation_messages.
 */
export async function lockConversation(client: QueryClient, type: string, conversationId: string): Promise<void> {
    const parentTable = type === 'direct' ? 'direct_conversations' : 'agent_conversations';
    await client.query(`SELECT id FROM ${parentTable} WHERE id = $1 FOR UPDATE`, [conversationId]);
}

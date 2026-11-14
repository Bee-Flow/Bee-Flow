/**
 * agentConversationsDelete.mts: conversations go with their messages.
 * conversation_messages has no FK to its conversation, so nothing else removes
 * them. Shared by the conversation deletes (./agentConversations.js,
 * ./directConversations.js), agent deletion (./agentCrud.js) and organisation
 * deletion (../user/organizations.js).
 *
 * conversation_messages is created by its own store, which may not have run on
 * a fresh install. Its presence is asked, not caught: a failed statement would
 * abort the caller's transaction.
 */

type Run = (sql: string, params?: unknown[]) => Promise<unknown>;
type WithTransaction = <T>(fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null, rows?: unknown[] }> }) => Promise<T>) => Promise<T>;

/** Delete the conversation_messages rows `where` picks through the caller's `run`, when the table exists. */
export async function deleteMessagesWhere(run: Run, where: string, params: unknown[]): Promise<void> {
    // A parameter keeps db.run from reading the statement as schema work (it does so for a bare one).
    const res = await run('SELECT to_regclass($1::text) IS NOT NULL AS present', ['conversation_messages']) as { rows?: { present?: boolean }[] } | null;
    if (res?.rows?.[0]?.present) await run(`DELETE FROM conversation_messages WHERE ${where}`, params);
}

/** Delete the agent's conversations and their messages through the caller's `run`. */
export async function deleteAgentConversations(run: Run, agentId: string): Promise<void> {
    await deleteMessagesWhere(run, 'conversation_id IN (SELECT id FROM agent_conversations WHERE agent_id = $1)', [agentId]);
    await run('DELETE FROM agent_conversations WHERE agent_id = $1', [agentId]);
}

/**
 * The agent row `where` picks and its conversations with their messages, in one transaction; with
 * `force` also its tool rows, and the conversations go whether or not the row was there. The
 * conversations go before the agent: they cascade with it, and the messages are found through
 * them. Answers how many agent rows went (the automation bindings are the caller's step after
 * the commit).
 */
export async function deleteAgentWithConversations(
    withTransaction: WithTransaction, id: string, where: string, params: unknown[], { force = false }: { force?: boolean } = {},
): Promise<number> {
    return withTransaction(async (client) => {
        const q: Run = (sql, p) => client.query(sql, p);
        if (force) await q('DELETE FROM agent_tools WHERE agent_id = $1', [id]);
        const found = (await client.query(`SELECT id FROM agents WHERE ${where} FOR UPDATE`, params)).rows?.length ?? 0;
        if (found > 0 || force) await deleteAgentConversations(q, id);
        return (await client.query(`DELETE FROM agents WHERE ${where}`, params)).rowCount ?? 0;
    });
}

/**
 * The conversations of `table` that `where` picks, and their messages, in one transaction. The
 * messages are those `messagesWhere` picks (by default: of the conversations about to go), with
 * the same parameters, so an override names every one of them. Answers how many conversations went.
 */
export async function deleteConversationsWhere(
    withTransaction: WithTransaction, table: 'agent_conversations' | 'direct_conversations', where: string, params: unknown[],
    messagesWhere = `conversation_id IN (SELECT id FROM ${table} WHERE ${where})`,
): Promise<number> {
    return withTransaction(async (client) => {
        await deleteMessagesWhere((sql, p) => client.query(sql, p), messagesWhere, params);
        return (await client.query(`DELETE FROM ${table} WHERE ${where}`, params)).rowCount ?? 0;
    });
}

/**
 * The order of a conversation's rows in `conversation_messages`, the lock
 * that keeps it well-defined, and where a finished turn's rows go. Used by
 * stores/agent/conversationMessages.js.
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

interface RowsClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The parent table of a conversation type. */
function parentTableOf(type: string): string {
    return type === 'direct' ? 'direct_conversations' : 'agent_conversations';
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
    await client.query(`SELECT id FROM ${parentTableOf(type)} WHERE id = $1 FOR UPDATE`, [conversationId]);
}

// ── Saving a finished turn ──────────────────────────────────────────────────

/** A stored row as the turn write sees it: its id and its position. */
export interface RowPosition {
    id: string;
    seq: number;
}

/**
 * Put a finished turn's rows into the stored conversation right after the
 * message the turn was asked on (`anchorId`), not after whatever is stored by
 * the time it finishes.
 *
 * A turn is saved at its END, on top of the conversation as it stands then.
 * If another turn on the same conversation finished in the meantime (a second
 * tab or device, or the question asked again after a dropped stream while the
 * server was still answering), appending puts the question asked FIRST below
 * the later question and its answer. Placing by anchor keeps the stored order
 * the order the questions were asked in; every reader (chat view, mobile,
 * export, the model's next history) reads that one order.
 *
 * No anchor, or an anchor that is not stored any more (an edit cut the chat):
 * append. Inputs are not mutated. Direct chat and agent chat place a turn by
 * this one rule (core/conversation/historyMerge.js re-exports it).
 */
export function placeTurnRows<T>(base: T[], rows: T[], anchorId: string | null | undefined): T[] {
    const at = anchorId
        ? base.findIndex((m) => !!m && typeof m === 'object' && (m as { id?: unknown }).id === anchorId)
        : -1;
    if (at < 0 || at === base.length - 1) return [...base, ...rows];
    return [...base.slice(0, at + 1), ...rows, ...base.slice(at + 1)];
}

export interface TurnPlan {
    /** Rows an earlier save of THIS turn stored (same ids): replaced, never kept twice. */
    replaceIds: string[];
    /** Stored rows of other turns whose seq changes to make room. Their content is not touched. */
    moves: RowPosition[];
    /** The seq of the turn's first row; its rows take startSeq, startSeq + 1, ... */
    startSeq: number;
}

/**
 * Plan a turn's save: its rows go right after `anchorId` (placeTurnRows),
 * and the conversation is renumbered densely around them. Rows of other turns
 * only move; the only rows a save removes are this turn's own earlier copies
 * (a turn saves after every tool round, then once more at its end).
 */
export function planTurnPlacement(
    stored: RowPosition[],
    turnIds: string[],
    anchorId: string | null,
): TurnPlan {
    const own = new Set(turnIds);
    const others = stored.filter((r) => !own.has(r.id));
    const seqOf = new Map(others.map((r) => [r.id, r.seq]));
    const order = placeTurnRows(
        others.map((r) => ({ id: r.id, turn: false })),
        turnIds.map((id) => ({ id, turn: true })),
        anchorId,
    );
    const moves: RowPosition[] = [];
    let startSeq = -1;
    order.forEach((slot, i) => {
        if (slot.turn) {
            if (startSeq < 0) startSeq = i;
        } else if (seqOf.get(slot.id) !== i) {
            moves.push({ id: slot.id, seq: i });
        }
    });
    return {
        replaceIds: stored.filter((r) => own.has(r.id)).map((r) => r.id),
        moves,
        startSeq: startSeq < 0 ? order.length : startSeq,
    };
}

export interface TurnWrite {
    type: string;
    conversationId: string;
    /** The turn's row ids, in order. Stable across the saves of one turn. */
    turnIds: string[];
    /** The last stored message the turn read as its history (null: append). */
    anchorId: string | null;
    /** Insert the turn's rows at seq startSeq, startSeq + 1, ... on this client. */
    insertRows(startSeq: number): Promise<void>;
}

/**
 * Save a finished turn's rows inside the caller's transaction, under the
 * conversation's row lock: placed after the message the turn was asked on,
 * without deleting or rewriting any row another turn stored.
 *
 * A full replace of the history the turn STARTED with lost every turn that
 * finished in the meantime (a second tab or device, the Nextcloud embed next
 * to the web app, a question asked again after a dropped stream while the
 * server was still answering): its rows were simply not in that array.
 *
 * Returns false, writing nothing, when the conversation still reads from its
 * legacy messages_json blob: rows here are then not what a reader sees, so the
 * caller writes the whole array instead.
 */
export async function writeTurnRows(client: RowsClient, w: TurnWrite): Promise<boolean> {
    await lockConversation(client, w.type, w.conversationId);
    const parent = await client.query(
        `SELECT messages_migrated FROM ${parentTableOf(w.type)} WHERE id = $1`,
        [w.conversationId],
    );
    if (parent.rows[0]?.messages_migrated !== true) return false;

    const { rows } = await client.query(
        `SELECT id, seq FROM conversation_messages WHERE conversation_id = $1 ${READ_ORDER}`,
        [w.conversationId],
    );
    const plan = planTurnPlacement(
        rows.map((r) => ({ id: String(r.id), seq: Number(r.seq) })),
        w.turnIds, w.anchorId,
    );
    if (plan.replaceIds.length > 0) {
        await client.query(
            'DELETE FROM conversation_messages WHERE conversation_id = $1 AND id = ANY($2::text[])',
            [w.conversationId, plan.replaceIds],
        );
    }
    if (plan.moves.length > 0) {
        await client.query(
            `UPDATE conversation_messages AS m SET seq = v.seq
               FROM unnest($2::text[], $3::int[]) AS v(id, seq)
              WHERE m.conversation_id = $1 AND m.id = v.id`,
            [w.conversationId, plan.moves.map((m) => m.id), plan.moves.map((m) => m.seq)],
        );
    }
    await w.insertRows(plan.startSeq);
    return true;
}

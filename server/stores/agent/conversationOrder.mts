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

/**
 * Which turn a row belongs to and when that turn was asked (milliseconds,
 * taken on the server when the turn STARTED, not when it was saved). Rows
 * without it (written before the columns existed, or by a whole-array write)
 * have none.
 */
export interface TurnMark {
    turnId: string;
    askedAt: number;
}

/** A stored row as the turn write sees it: its id, its position and its turn. */
export interface RowPosition {
    id: string;
    seq: number;
    mark: TurnMark | null;
}

/** The mark an item carries as `turnId` + `turnAskedAt` (a Date, an ISO string or ms), or null. */
export function markOf(item: unknown): TurnMark | null {
    if (!item || typeof item !== 'object') return null;
    const { turnId, turnAskedAt } = item as { turnId?: unknown; turnAskedAt?: unknown };
    const askedAt = turnAskedAt instanceof Date ? turnAskedAt.getTime()
        : typeof turnAskedAt === 'string' ? Date.parse(turnAskedAt)
            : typeof turnAskedAt === 'number' ? turnAskedAt : NaN;
    return typeof turnId === 'string' && turnId && Number.isFinite(askedAt) ? { turnId, askedAt } : null;
}

/** Was turn `a` asked before turn `b`? Same time: the turn id decides, so the order is total. */
function askedBefore(a: TurnMark, b: TurnMark): boolean {
    return a.askedAt < b.askedAt || (a.askedAt === b.askedAt && a.turnId < b.turnId);
}

/**
 * Put a finished turn's rows into the stored conversation after the message
 * the turn was asked on (`anchorId`), not after whatever is stored by the
 * time it finishes.
 *
 * A turn is saved at its END. Turns that read the same history overlap (a
 * second tab or device, the Nextcloud embed next to the web app, the question
 * asked again after a dropped stream while the server was still answering),
 * and they finish in any order. Right after the anchor, the turns already
 * stored there that were asked EARLIER than this one (`mark`, see TurnMark)
 * are skipped, whole turns at a time, so the stored order is the order the
 * questions were asked in, whichever finished first. The first row without a
 * mark, or of a turn asked later, stops the skip. Every reader (chat view,
 * mobile, export, the model's next history) reads that one order.
 *
 * No anchor, or an anchor that is not stored any more (an edit cut the chat):
 * append. No mark: right after the anchor. Inputs are not mutated. Direct
 * chat and agent chat place a turn by this one rule
 * (core/conversation/historyMerge.js re-exports it); stored items carry their
 * mark as `turnId` + `turnAskedAt`.
 */
export function placeTurnRows<T>(base: T[], rows: T[], anchorId: string | null | undefined, mark: TurnMark | null = null): T[] {
    const at = anchorId
        ? base.findIndex((m) => !!m && typeof m === 'object' && (m as { id?: unknown }).id === anchorId)
        : -1;
    if (at < 0) return [...base, ...rows];
    let i = at + 1;
    if (mark) {
        for (let next = markOf(base[i]); i < base.length && next && askedBefore(next, mark); next = markOf(base[i])) {
            const { turnId } = next;
            while (i < base.length && markOf(base[i])?.turnId === turnId) i++;
        }
    }
    return [...base.slice(0, i), ...rows, ...base.slice(i)];
}

export interface TurnPlan {
    /** Rows an earlier save of THIS turn stored (same ids): replaced, never kept twice. */
    replaceIds: string[];
    /** Stored rows of other turns whose seq changes to make room. Their content is not touched. */
    moves: Array<{ id: string; seq: number }>;
    /** The seq of the turn's first row; its rows take startSeq, startSeq + 1, ... */
    startSeq: number;
}

/**
 * Plan a turn's save: its rows go where placeTurnRows puts them, and the
 * conversation is renumbered densely around them. Rows of other turns only
 * move; the only rows a save removes are this turn's own earlier copies (a
 * turn saves after every tool round, then once more at its end).
 */
export function planTurnPlacement(
    stored: RowPosition[],
    turnIds: string[],
    anchorId: string | null,
    mark: TurnMark | null = null,
): TurnPlan {
    const own = new Set(turnIds);
    const others = stored.filter((r) => !own.has(r.id));
    const seqOf = new Map(others.map((r) => [r.id, r.seq]));
    const order = placeTurnRows(
        others.map((r) => ({ id: r.id, turn: false, turnId: r.mark?.turnId, turnAskedAt: r.mark?.askedAt })),
        turnIds.map((id) => ({ id, turn: true, turnId: undefined, turnAskedAt: undefined })),
        anchorId,
        mark,
    );
    const moves: Array<{ id: string; seq: number }> = [];
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
    /** When the turn was asked; stored on its rows. Null: placed right after the anchor, unmarked. */
    mark: TurnMark | null;
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
        `SELECT messages_migrated, messages_json FROM ${parentTableOf(w.type)} WHERE id = $1`,
        [w.conversationId],
    );
    const { rows } = await client.query(
        `SELECT id, seq, turn_id, turn_asked_at FROM conversation_messages WHERE conversation_id = $1 ${READ_ORDER}`,
        [w.conversationId],
    );
    if (parent.rows[0]?.messages_migrated !== true) {
        // A conversation with nothing in its blob and nothing here (a new
        // chat) reads the same from this table: switch it over and go on.
        const blob = parent.rows[0]?.messages_json;
        if (!parent.rows[0] || rows.length > 0 || !(blob === null || blob === '' || blob === '[]')) return false;
        await client.query(`UPDATE ${parentTableOf(w.type)} SET messages_migrated = TRUE WHERE id = $1`, [w.conversationId]);
    }

    const plan = planTurnPlacement(
        rows.map((r) => ({
            id: String(r.id),
            seq: Number(r.seq),
            mark: markOf({ turnId: r.turn_id, turnAskedAt: r.turn_asked_at }),
        })),
        w.turnIds, w.anchorId, w.mark,
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
    if (w.mark) {
        await client.query(
            `UPDATE conversation_messages SET turn_id = $2, turn_asked_at = $3
              WHERE conversation_id = $1 AND id = ANY($4::text[])`,
            [w.conversationId, w.mark.turnId, new Date(w.mark.askedAt).toISOString(), w.turnIds],
        );
    }
    return true;
}

/**
 * awareness.ts — what a co-editor tells the others about themselves: who they
 * are (a user id, stamped again by the server) and where their caret is (two
 * Yjs relative positions, base64). Nothing else: no name (names come from the
 * project's member list, so nobody can put a fake one on their caret), and
 * never any document text.
 *
 * Everything read back is untrusted input from another browser, so readPeers
 * validates shapes and sizes before anything is rendered.
 */
import type { Awareness } from 'y-protocols/awareness';

/** A caret or selection as two encoded relative positions. */
export interface CursorState {
    anchor: string;
    head: string;
}

export interface PeerPresence {
    clientId: number;
    userId: string;
    cursor: CursorState | null;
    /** True while the peer has the editor focused. */
    editing: boolean;
}

const MAX_ID_LENGTH = 128;
const MAX_POSITION_LENGTH = 512;
const DEFAULT_THROTTLE_MS = 100;

/** Announce who this client is. The server overwrites `user.id` with the session's. */
export function setLocalUser(awareness: Awareness, userId: string): void {
    awareness.setLocalStateField('user', { id: String(userId).slice(0, MAX_ID_LENGTH) });
}

function validCursor(raw: unknown): CursorState | null {
    if (!raw || typeof raw !== 'object') return null;
    const { anchor, head } = raw as Record<string, unknown>;
    if (typeof anchor !== 'string' || typeof head !== 'string') return null;
    if (!anchor || !head || anchor.length > MAX_POSITION_LENGTH || head.length > MAX_POSITION_LENGTH) return null;
    return { anchor, head };
}

/** The other clients, validated. Clients without a user id are ignored. */
export function readPeers(awareness: Awareness): PeerPresence[] {
    const out: PeerPresence[] = [];
    awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID || !state || typeof state !== 'object') return;
        const user = (state as Record<string, unknown>).user as Record<string, unknown> | undefined;
        const userId = user && typeof user.id === 'string' ? user.id : '';
        if (!userId || userId.length > MAX_ID_LENGTH) return;
        out.push({
            clientId,
            userId,
            cursor: validCursor((state as Record<string, unknown>).cursor),
            editing: (state as Record<string, unknown>).editing === true,
        });
    });
    return out.sort((a, b) => a.clientId - b.clientId);
}

export interface CursorPublisher {
    /** Queue the latest caret; at most one awareness change per throttle window. */
    publish(cursor: CursorState | null, editing: boolean): void;
    /** Send whatever is queued right now. */
    flush(): void;
    cancel(): void;
}

/**
 * Throttled writer for the local cursor. Leading edge immediately, then at
 * most one trailing change per window carrying the LATEST value, so a burst
 * of caret moves costs two awareness updates, not twenty. An unchanged value
 * is not re-sent (the awareness protocol renews the state by itself).
 */
export function createCursorPublisher(
    awareness: Awareness,
    { throttleMs = DEFAULT_THROTTLE_MS }: { throttleMs?: number } = {},
): CursorPublisher {
    let pending: { cursor: CursorState | null; editing: boolean } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';

    const write = () => {
        if (!pending) return;
        const next = pending;
        pending = null;
        const key = JSON.stringify(next);
        if (key === last) return;
        last = key;
        const state = awareness.getLocalState() || {};
        awareness.setLocalState({ ...state, cursor: next.cursor, editing: next.editing });
    };

    return {
        publish(cursor, editing) {
            pending = { cursor, editing };
            if (timer) return;
            write();
            timer = setTimeout(() => { timer = null; write(); }, throttleMs);
        },
        flush() {
            if (timer) { clearTimeout(timer); timer = null; }
            write();
        },
        cancel() {
            if (timer) { clearTimeout(timer); timer = null; }
            pending = null;
        },
    };
}

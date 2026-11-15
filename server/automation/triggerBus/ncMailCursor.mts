/**
 * The `mail.new` cursor of one subscription, shared by its two producers.
 *
 * A Nextcloud Mail message id is the row id of Mail's message table, so it
 * only grows. The cursor remembers, per mailbox, the highest id this
 * subscription has been handed (`{ "boxes": { "<mailboxId>": <messageId> } }`
 * in `lastCursor`). The connector's push writes it for every message it
 * delivers, the poller reads it and writes it too, so a message the push
 * already delivered is not read again by the poller (which runs when no push
 * came for a while, or always on an older connector), and the other way round.
 *
 * At most MAX_BOXES mailboxes are kept: those with the most recent messages
 * (ids grow, so the lowest last id is the mailbox that was quiet longest).
 * One that drops out is anchored again by the poller (nothing old is replayed).
 */

export const MAX_BOXES = 50;

export type MailCursor = { boxes: Record<string, number> };

function idNumber(v: unknown): number | null {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The cursor in `lastCursor`, or an empty one (a cursor of another shape too). */
export function parseMailCursor(lastCursor: unknown): MailCursor {
    if (typeof lastCursor !== 'string' || !lastCursor) return { boxes: {} };
    let raw: unknown;
    try { raw = JSON.parse(lastCursor); } catch { return { boxes: {} }; }
    const boxes: Record<string, number> = {};
    const src = raw && typeof raw === 'object' && 'boxes' in raw ? (raw as { boxes: unknown }).boxes : null;
    if (src && typeof src === 'object') {
        for (const [box, last] of Object.entries(src as Record<string, unknown>)) {
            const id = idNumber(last);
            if (idNumber(box) !== null && id !== null) boxes[box] = id;
        }
    }
    return { boxes };
}

/** The highest message id handed out for this mailbox, or null when it has none yet. */
export function lastSeen(cursor: MailCursor, mailboxId: unknown): number | null {
    const box = idNumber(mailboxId);
    return box === null ? null : (cursor.boxes[String(box)] ?? null);
}

/** True when this message is at or below what the mailbox's cursor already handed out. */
export function alreadyHandedOut(lastCursor: unknown, mailboxId: unknown, messageId: unknown): boolean {
    const id = idNumber(messageId);
    const last = lastSeen(parseMailCursor(lastCursor), mailboxId);
    return id !== null && last !== null && id <= last;
}

/** The cursor with this mailbox at `messageId` (never lowered), as `lastCursor` text. */
export function advanceMailCursor(lastCursor: unknown, mailboxId: unknown, messageId: unknown): string {
    const cursor = parseMailCursor(lastCursor);
    const box = idNumber(mailboxId);
    const id = idNumber(messageId);
    if (box !== null && id !== null) {
        const key = String(box);
        cursor.boxes[key] = Math.max(cursor.boxes[key] ?? 0, id);
    }
    const quietestFirst = Object.entries(cursor.boxes).sort((a, b) => a[1] - b[1]);
    for (const [key] of quietestFirst.slice(0, Math.max(0, quietestFirst.length - MAX_BOXES))) delete cursor.boxes[key];
    return JSON.stringify(cursor);
}

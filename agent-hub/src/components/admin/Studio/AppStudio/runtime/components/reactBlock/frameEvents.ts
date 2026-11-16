/**
 * App Studio runtime: what may come OUT of a react_block's sealed frame.
 *
 * The frame runs code the builder wrote, so everything it posts is untrusted. ReactFrame already
 * hands over only messages whose source is this block's own frame window; here an event is
 * accepted only when it is one the block wired to an action (an allow-list by own key, so
 * `__proto__` and friends never match), its value is plain JSON of at most
 * EVENT_VALUE_MAX_BYTES, and the block has not raised more than EVENT_RATE_MAX events in the
 * last EVENT_RATE_WINDOW_MS. Anything else is dropped without a word.
 */

/** The largest value an event may carry, as UTF-8 JSON. */
export const EVENT_VALUE_MAX_BYTES = 16 * 1024;
/** At most this many events per window per block; a runaway loop cannot flood the action runner. */
export const EVENT_RATE_MAX = 10;
export const EVENT_RATE_WINDOW_MS = 1000;
const EVENT_NAME_MAX = 40;

export interface FrameEvent {
    event: string;
    actionId: string;
    value: unknown;
}

function utf8Length(text: string): number {
    return new TextEncoder().encode(text).length;
}

/**
 * The action a `bf-react-event` message may run, with its value as plain JSON; null when the
 * message is not such an event, names an event that is not wired, or carries too much.
 */
export function acceptFrameEvent(data: unknown, wired: Readonly<Record<string, string>>): FrameEvent | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const message = data as Record<string, unknown>;
    if (message.type !== 'bf-react-event') return null;
    const event = message.event;
    if (typeof event !== 'string' || !event || event.length > EVENT_NAME_MAX || !Object.hasOwn(wired, event)) return null;
    const actionId = wired[event];
    if (typeof actionId !== 'string' || !actionId) return null;
    let json: string | undefined;
    try {
        json = JSON.stringify(message.value === undefined ? null : message.value);
    } catch {
        return null;
    }
    if (typeof json !== 'string' || utf8Length(json) > EVENT_VALUE_MAX_BYTES) return null;
    return { event, actionId, value: JSON.parse(json) as unknown };
}

/** A gate that lets at most EVENT_RATE_MAX calls through per EVENT_RATE_WINDOW_MS. */
export function createEventGate(now: () => number = Date.now): () => boolean {
    const recent: number[] = [];
    return () => {
        const t = now();
        while (recent.length && t - recent[0] >= EVENT_RATE_WINDOW_MS) recent.shift();
        if (recent.length >= EVENT_RATE_MAX) return false;
        recent.push(t);
        return true;
    };
}

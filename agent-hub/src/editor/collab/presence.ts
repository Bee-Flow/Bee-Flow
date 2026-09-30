/**
 * presence.ts — the co-editing provider's awareness channel: who is in the
 * document and where their caret is.
 *
 * Our own state is sent throttled (AWARENESS_MS) whenever it changes, and in
 * full when asked. `announce` asks everyone else for theirs as well; the
 * provider calls it once this client's document stream is attached (the
 * `doc.joined` frame), because answers relayed before that never reach us.
 * Presence is best-effort throughout: a lost message is repaired by the next
 * heartbeat, and nothing here carries document content.
 */
import {
    type Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates,
} from 'y-protocols/awareness';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { AWARENESS_MS, REMOTE_ORIGIN } from './providerSupport';

export interface PresenceHost {
    /** POST a body to the document's awareness endpoint (never throws). */
    post(body: Record<string, unknown>): void;
    /** Whether the session may send presence now (joined, not ended). */
    live(): boolean;
    /** Someone else's presence changed (observers re-render). */
    changed(): void;
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

export class PresenceChannel {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(private readonly awareness: Awareness, private readonly host: PresenceHost) {
        awareness.on('update', this.onUpdate);
    }

    private get clientId(): number { return this.awareness.clientID; }

    private onUpdate = ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
        if (origin === 'local' && !this.timer && !this.stopped) {
            this.timer = setTimeout(() => { this.timer = null; this.send(); }, AWARENESS_MS);
        }
        const others = [...added, ...updated, ...removed].some((id) => id !== this.clientId);
        if (others || origin !== 'local') this.host.changed();
    };

    /** Our own state, now. */
    send() {
        if (this.stopped || !this.host.live()) return;
        this.host.post({ update: toBase64(encodeAwarenessUpdate(this.awareness, [this.clientId])) });
    }

    /** Ask everyone for their state, and send ours. */
    announce() {
        if (this.stopped || !this.host.live()) return;
        this.host.post({ query: true });
        this.send();
    }

    /** A `doc.awareness` frame. */
    apply(encoded: unknown) {
        if (typeof encoded !== 'string' || this.stopped) return;
        try { applyAwarenessUpdate(this.awareness, fromBase64(encoded), REMOTE_ORIGIN); } catch { /* ignore a bad frame */ }
    }

    /** Best-effort goodbye; the 30 s timeout covers a lost one. */
    leave() {
        if (!this.stopped) this.host.post({ leave: this.clientId });
    }

    /** Stop the throttle timer (the session ended). */
    cancel() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }

    destroy() {
        this.cancel();
        this.stopped = true;
        this.awareness.off('update', this.onUpdate);
        try { removeAwarenessStates(this.awareness, [this.clientId], 'local'); } catch { /* noop */ }
        this.awareness.destroy();
    }
}

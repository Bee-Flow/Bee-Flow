/**
 * streamState.ts — how the co-editing provider's document stream is doing,
 * and what it does about it.
 *
 *   - down: the stream has been disconnected for longer than a short grace
 *     (a quick reconnect never flashes "offline");
 *   - polling: the stream fell back to polling, so no document frames come in
 *     and the document is synced on a timer instead;
 *   - detached: the server let go of this document's stream for a reason that
 *     may pass (doc.closed 'unavailable' / 'not_found'). The document is
 *     synced on a timer, and the stream is opened again after a pause that
 *     grows while it keeps failing; `joined` (the doc.joined frame) ends it.
 */
import { MAX_RETRY_MS, OFFLINE_GRACE_MS, POLL_SYNC_MS } from './providerSupport';

export interface StreamHost {
    /** Run a state-vector sync (catches up whatever the stream did not bring). */
    sync(): void;
    /** `offline` changed. */
    changed(): void;
    /** Open the document stream again. */
    reopen(): void;
    /** The session is over: do nothing more. */
    ended(): boolean;
}

type Timer = ReturnType<typeof setTimeout>;

export class StreamState {
    private down = false;
    private polling = false;
    private detached = false;
    private offlineTimer: Timer | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private reopenTimer: Timer | null = null;
    private reopenDelay = 1000;

    constructor(private readonly host: StreamHost) {}

    /** No live document frames right now. */
    get offline(): boolean { return this.down || this.detached; }

    /** The transport's own state (useProjectStream's onStatus), 'stopped' excepted. */
    transport(status: 'connecting' | 'live' | 'polling') {
        if (status === 'polling') this.polling = true;
        if (status === 'live') this.polling = false;
        this.refreshPolling();
        if (status === 'live') {
            if (this.offlineTimer) { clearTimeout(this.offlineTimer); this.offlineTimer = null; }
            if (this.down) { this.down = false; this.host.changed(); }
            return;
        }
        if (!this.offlineTimer && !this.down) {
            this.offlineTimer = setTimeout(() => { this.offlineTimer = null; this.down = true; this.host.changed(); }, OFFLINE_GRACE_MS);
        }
    }

    /** The server let go of this document's stream: sync now, poll meanwhile, reopen after a pause. */
    detach() {
        if (this.host.ended()) return;
        if (!this.detached) { this.detached = true; this.refreshPolling(); this.host.changed(); }
        this.host.sync();
        if (this.reopenTimer) return;
        const delay = this.reopenDelay;
        this.reopenDelay = Math.min(delay * 2, MAX_RETRY_MS);
        this.reopenTimer = setTimeout(() => {
            this.reopenTimer = null;
            if (!this.host.ended()) this.host.reopen();
        }, delay);
    }

    /** The document stream is attached again. */
    joined() {
        this.reopenDelay = 1000;
        if (!this.detached) return;
        this.detached = false;
        this.refreshPolling();
        this.host.changed();
    }

    /** Sync on a timer while no stream brings this document's frames. */
    private refreshPolling() {
        const need = (this.polling || this.detached) && !this.host.ended();
        if (need && !this.pollTimer) this.pollTimer = setInterval(() => this.host.sync(), POLL_SYNC_MS);
        else if (!need && this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    }

    cancel() {
        for (const t of [this.offlineTimer, this.reopenTimer]) if (t) clearTimeout(t);
        this.offlineTimer = null;
        this.reopenTimer = null;
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    }
}

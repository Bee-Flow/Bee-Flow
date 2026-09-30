/**
 * sender.ts — sends the co-editing provider's local updates.
 *
 *   - Batched: a burst of typing waits BATCH_MS and leaves as one request,
 *     with ONE request in flight at a time (the queue is outbox.ts).
 *   - A request that fails in a way that may pass (network, timeout, rate
 *     limit, server error) keeps its batch and is retried with backoff.
 *   - A batch the server finds too large together is sent again in parts
 *     (the server's contract for 413 UPDATE_TOO_LARGE).
 *   - A 403 means the role changed: nothing more is sent, the document stays
 *     readable. A single change the server can never take ends the session:
 *     every later edit of this client builds on it. The host hears of the end
 *     BEFORE the queue is dropped, so it can note that edits were never
 *     confirmed (they are then only in the local document, for the page to keep).
 */
import { toBase64 } from 'lib0/buffer';
import { Outbox, chunkByBytes, mergeAll } from './outbox';
import { BATCH_MS, MAX_RETRY_MS, codeOf, errorOf, retryable, type CollabHttp } from './providerSupport';

export interface SenderHost {
    http: CollabHttp;
    batchMs?: number;
    /** Where updates go and who sends them, or null while nothing may be sent (not joined, a viewer, the session over). */
    target(): { path: string; clientId: number } | null;
    /** A request failed and is retried: the connection counts as down. */
    failing(): void;
    /** A request went through. */
    sent(): void;
    /** The server refused the role (403): stop sending, stay readable. */
    refused(code: string): void;
    /** A change the server can never take: end the session. */
    fatal(code: string): void;
}

export class Sender {
    private readonly outbox = new Outbox();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private retryDelay = 1000;
    private stopped = false;

    constructor(private readonly host: SenderHost) {}

    /** Something is not confirmed by the server yet. */
    get pending(): boolean { return this.outbox.pending; }

    push(update: Uint8Array) {
        this.outbox.push(update);
        this.schedule(this.host.batchMs ?? BATCH_MS);
    }

    /** A sync found what the server lacks; send it right away. */
    catchUp(missing: Uint8Array, localStateVector: Uint8Array) {
        this.outbox.catchUp(missing, localStateVector);
        this.schedule(0);
    }

    clear() { this.outbox.clear(); }

    private schedule(delay: number) {
        if (this.timer || this.outbox.inFlight || this.stopped) return;
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay);
    }

    private body(batch: readonly Uint8Array[], clientId: number) {
        return { clientId, updates: [toBase64(mergeAll(batch))] };
    }

    /** Send the next batch now (one request in flight at a time). */
    async flush(): Promise<void> {
        const target = this.host.target();
        if (this.stopped || this.outbox.inFlight || !this.outbox.size || !target) return;
        const batch = this.outbox.take();
        try {
            await this.host.http.post(target.path, this.body(batch, target.clientId));
            if (this.stopped) return;
            this.outbox.settle(true);
            this.retryDelay = 1000;
            this.host.sent();
        } catch (e) {
            if (this.stopped) return;
            this.outbox.settle(false);
            if (this.onFailed(e, batch)) return;
        }
        if (this.outbox.size) this.schedule(this.host.batchMs ?? BATCH_MS);
    }

    /** A failed request (its batch is back in the queue): true when it is tried again. */
    private onFailed(e: unknown, batch: Uint8Array[]): boolean {
        const { status, code } = errorOf(e);
        if (retryable(status)) {
            this.host.failing();
            const delay = this.retryDelay;
            this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
            this.schedule(delay);
            return true;
        }
        if (status === 413 && this.outbox.split(batch)) { this.schedule(0); return true; }
        if (status === 403) {
            this.outbox.clear();
            this.host.refused(code || 'READ_ONLY');
            return false;
        }
        // Told while the queue still holds what was never confirmed (the host reads `pending`).
        this.host.fatal(codeOf(status, code));
        this.outbox.clear();
        return false;
    }

    /**
     * Send everything not confirmed without waiting, the batch in flight
     * included (twice is harmless): the page or the component is going away.
     * `keepalive` requests outlive a closing page.
     */
    sendRest(keepalive: boolean) {
        const target = this.host.target();
        if (!target || this.stopped || !this.outbox.pending) return;
        const { http } = this.host;
        for (const run of chunkByBytes(this.outbox.all(), this.outbox.budget)) {
            const body = this.body(run, target.clientId);
            try {
                if (keepalive && http.beacon) http.beacon(target.path, body);
                else http.post(target.path, body).catch(() => { /* best effort */ });
            } catch { /* best effort */ }
        }
    }

    cancel() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }

    /** Nothing more is sent (the session ended). */
    stop() {
        this.stopped = true;
        this.cancel();
        this.outbox.clear();
    }
}


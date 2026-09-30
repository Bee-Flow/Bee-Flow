/**
 * inbound.ts — remote updates off the stream, applied once per animation
 * frame in ONE transaction, so a burst of remote typing costs one editor
 * refresh however fast it arrives.
 */
import * as Y from 'yjs';
import { REMOTE_ORIGIN, defaultScheduleFrame } from './providerSupport';

export class InboundQueue {
    private queue: Uint8Array[] = [];
    private cancelFrame: (() => void) | null = null;

    constructor(
        private readonly ydoc: Y.Doc,
        /** Called when an update could not be applied (the caller resyncs). */
        private readonly onBroken: () => void,
        private readonly scheduleFrame: (fn: () => void) => () => void = defaultScheduleFrame,
    ) {}

    push(update: Uint8Array) {
        this.queue.push(update);
        if (this.cancelFrame) return;
        this.cancelFrame = this.scheduleFrame(() => { this.cancelFrame = null; this.apply(); });
    }

    /** Apply everything queued now, in one transaction. */
    apply() {
        this.cancel();
        const queue = this.queue;
        this.queue = [];
        if (!queue.length) return;
        try {
            this.ydoc.transact(() => { for (const u of queue) Y.applyUpdate(this.ydoc, u, REMOTE_ORIGIN); }, REMOTE_ORIGIN);
        } catch {
            this.onBroken();
        }
    }

    cancel() {
        if (this.cancelFrame) { this.cancelFrame(); this.cancelFrame = null; }
    }
}

/**
 * outbox.ts — the co-editing provider's local updates that the server has not
 * confirmed yet.
 *
 * Rules this file keeps:
 *   - A batch is taken OUT of the queue while its request is in flight. What
 *     lands in the queue meanwhile (new typing, or the catch-up a sync puts
 *     there) is never mistaken for it, and a failed batch goes back in front.
 *     Sending something twice is harmless: applying a Yjs update twice is a
 *     no-op, so keeping too much is always the safe side.
 *   - A request carries ONE update: the batch merged. The server counts its
 *     rate limit per update and merges a request's updates anyway.
 *   - Batches are bounded by bytes. Updates stay separate in the queue, so a
 *     batch the server finds too large is split and sent again in parts.
 */
import * as Y from 'yjs';

/** Most bytes of updates per request (the server takes one update of up to 576 KB). */
export const MAX_BATCH_BYTES = 256 * 1024;

const bytesOf = (list: readonly Uint8Array[]) => list.reduce((n, u) => n + u.length, 0);

/** One update holding all of `list`. */
export function mergeAll(list: readonly Uint8Array[]): Uint8Array {
    return list.length === 1 ? list[0] : Y.mergeUpdates(list as Uint8Array[]);
}

/** Whether the structs of `update` all lie in clock ranges that `parts` hold. */
function covers(parts: readonly Uint8Array[], update: Uint8Array): boolean {
    const need = Y.parseUpdateMeta(update);
    const have = parts.map((u) => Y.parseUpdateMeta(u));
    for (const [client, from] of need.from) {
        const to = need.to.get(client) ?? from;
        const ranges = have
            .map((m) => [m.from.get(client), m.to.get(client)] as const)
            .filter((r): r is readonly [number, number] => r[0] !== undefined && r[1] !== undefined)
            .sort((x, y) => x[0] - y[0]);
        let reached = from;
        for (const [a, b] of ranges) {
            if (a > reached) break;
            reached = Math.max(reached, b);
        }
        if (reached < to) return false;
    }
    return true;
}

/** `list` cut into runs of at most `budget` bytes (a larger update is a run of its own). */
export function chunkByBytes(list: readonly Uint8Array[], budget: number): Uint8Array[][] {
    const out: Uint8Array[][] = [];
    let run: Uint8Array[] = [];
    let bytes = 0;
    for (const u of list) {
        if (run.length && bytes + u.length > budget) { out.push(run); run = []; bytes = 0; }
        run.push(u);
        bytes += u.length;
    }
    if (run.length) out.push(run);
    return out;
}

export class Outbox {
    private queue: Uint8Array[] = [];
    /** The batch whose request is in flight, or null. */
    inFlight: Uint8Array[] | null = null;
    /** Most bytes per request; lowered when the server finds a batch too large. */
    budget: number;

    constructor(budget = MAX_BATCH_BYTES) { this.budget = budget; }

    get size(): number { return this.queue.length; }
    /** Something is not confirmed yet (queued or in flight). */
    get pending(): boolean { return this.inFlight !== null || this.queue.length > 0; }

    push(update: Uint8Array) { this.queue.push(update); }

    clear() { this.queue = []; }

    /**
     * A sync found that the server lacks `missing`. A small catch-up replaces
     * the queue (it holds everything the queue does). A large one would be a
     * single update the server may refuse and that cannot be split: when the
     * separate updates not confirmed yet hold every struct it has, they stay
     * and only its delete set is added; otherwise it goes as it is.
     */
    catchUp(missing: Uint8Array, localStateVector: Uint8Array) {
        if (missing.length <= this.budget) { this.queue = [missing]; return; }
        const unconfirmed = this.all();
        this.queue.push(unconfirmed.length && covers(unconfirmed, missing) ? Y.diffUpdate(missing, localStateVector) : missing);
    }

    /** The next batch (at least one update, at most `budget` bytes), now in flight. */
    take(): Uint8Array[] {
        let n = 0;
        let bytes = 0;
        while (n < this.queue.length && (n === 0 || bytes + this.queue[n].length <= this.budget)) {
            bytes += this.queue[n].length;
            n += 1;
        }
        this.inFlight = this.queue.slice(0, n);
        this.queue = this.queue.slice(n);
        return this.inFlight;
    }

    /** The request ended: confirmed (dropped), or not (back in front of what queued up since). */
    settle(confirmed: boolean) {
        if (!confirmed && this.inFlight) this.queue = this.inFlight.concat(this.queue);
        this.inFlight = null;
    }

    /** The server found `batch` too large: send it in smaller parts. False for a single update. */
    split(batch: readonly Uint8Array[]): boolean {
        if (batch.length < 2) return false;
        this.budget = Math.max(1, Math.floor(bytesOf(batch) / 2));
        return true;
    }

    /** Everything not confirmed: the batch in flight, then the queue. */
    all(): Uint8Array[] { return [...(this.inFlight || []), ...this.queue]; }
}

// @typecheck strict
/**
 * A sleep that ends early when the run is cancelled.
 *
 * The wait between two tries of a step (stepDispatch.retryStep, the per-item
 * retry in execFlow) used a bare setTimeout: a cancelled or timed-out run sat
 * out the whole backoff before anything looked at the cancel signal, and the
 * run could not be finalised meanwhile (raceRunDag waits for the DAG to
 * unwind). Resolves either way; the caller checks for the cancel afterwards.
 *
 * @param {number} ms
 * @param {AbortSignal | null | undefined} signal  the run's in-process cancel signal
 * @returns {Promise<void>}
 */
function cancellableSleep(ms, signal) {
    const delay = Number(ms) || 0;
    if (delay <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', done);
            resolve();
        };
        const timer = setTimeout(done, delay);
        signal?.addEventListener?.('abort', done, { once: true });
    });
}

/** How often a sleeping Wait reads the run row's cancel_requested flag. */
const CANCEL_FLAG_POLL_MS = 30_000;

/**
 * The Wait step's sleep: until `until` (epoch ms), in chunks of at most five
 * seconds on unref'd timers, so a cancel lands within one chunk and a pending
 * Wait never holds a draining worker open. Throws 'Run cancelled'.
 *
 * The abort signal only fires for a cancel issued on THIS instance. One issued
 * on another sets cancel_requested on the run row, which dispatchStep reads
 * between steps — and a Wait is a single step that may last a day. So the
 * sleep reads that flag as well (ctx.cancelRequested, set in runDeadline.js),
 * every 30 seconds; a failed lookup is not a cancel.
 *
 * @param {number} until
 * @param {{ cancelSignal?: AbortSignal | null, cancelRequested?: (() => Promise<boolean>) | null }} ctx
 * @returns {Promise<void>}
 */
async function sleepUntil(until, ctx) {
    let flagCheckedAt = Date.now();
    while (Date.now() < until) {
        if (ctx.cancelSignal?.aborted) throw new Error('Run cancelled');
        const cancelRequested = ctx.cancelRequested;
        if (typeof cancelRequested === 'function' && Date.now() - flagCheckedAt >= CANCEL_FLAG_POLL_MS) {
            flagCheckedAt = Date.now();
            if (await Promise.resolve().then(() => cancelRequested()).catch(() => false)) throw new Error('Run cancelled');
        }
        await new Promise((resolve) => {
            const t = setTimeout(resolve, Math.min(5_000, Math.max(0, until - Date.now())));
            if (t.unref) t.unref();
        });
    }
}

module.exports = { cancellableSleep, sleepUntil };

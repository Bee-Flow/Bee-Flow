// @typecheck
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

module.exports = { cancellableSleep };

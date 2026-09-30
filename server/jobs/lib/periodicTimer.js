// @typecheck
/**
 * The two timers of a periodic job: one pass `bootDelayMs` after start (a
 * short-lived replica may never see its first interval, and a pod that just
 * booted should not wait a whole interval for work that piled up while it
 * was down), then one every `intervalMs`. Both are unref'd, so a job never
 * holds the process open.
 *
 *   const timer = periodicTimer({ bootDelayMs, intervalMs, run: (when) => pass(when) });
 *   timer.start();   // true when it started, false when it was running already
 *   timer.stop();
 *
 * `run` gets 'initial' for the boot pass and 'scheduled' for the others. A
 * pass that rejects is swallowed here: the job logs its own failures, and a
 * timer callback must never become an unhandled rejection.
 */

'use strict';

/**
 * @param {{ bootDelayMs: number, intervalMs: number, run: (when: 'initial'|'scheduled') => unknown }} opts
 * @returns {{ start: () => boolean, stop: () => void }}
 */
function periodicTimer({ bootDelayMs, intervalMs, run }) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let boot = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let interval = null;
    /** @param {'initial'|'scheduled'} when */
    const tick = (when) => { Promise.resolve().then(() => run(when)).catch(() => {}); };
    return {
        start() {
            if (interval) return false;
            boot = setTimeout(() => { boot = null; tick('initial'); }, bootDelayMs);
            interval = setInterval(() => tick('scheduled'), intervalMs);
            boot.unref?.();
            interval.unref?.();
            return true;
        },
        stop() {
            if (boot) { clearTimeout(boot); boot = null; }
            if (interval) { clearInterval(interval); interval = null; }
        },
    };
}

/**
 * A job module's start() and stop(): the timer above, plus the job's own
 * "Started" line, logged only when start() actually started it (a second
 * start is a no-op and says nothing).
 *
 *   const { start, stop } = periodicJob({ bootDelayMs, intervalMs, run, onStart: () => log.info('Started') });
 *
 * @param {{ bootDelayMs: number, intervalMs: number, run: (when: 'initial'|'scheduled') => unknown, onStart: () => void }} opts
 * @returns {{ start: () => void, stop: () => void }}
 */
function periodicJob({ onStart, ...timerOpts }) {
    const timer = periodicTimer(timerOpts);
    return {
        start() { if (timer.start()) onStart(); },
        stop() { timer.stop(); },
    };
}

module.exports = { periodicTimer, periodicJob };

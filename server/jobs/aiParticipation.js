// @typecheck
/**
 * The background half of the AI that decides by itself when to take part:
 * every TICK_MS it claims the watches that came due (projects/participation)
 * and hands each to the engine, which re-reads the conversation, asks the
 * relevance gate and answers or stays silent.
 *
 * ── Several replicas ────────────────────────────────────────────────────────
 *
 * No advisory lock: the claim IS the coordination. `claimDue` flips each row
 * to `claimed` in the statement that selects it (FOR UPDATE SKIP LOCKED) and
 * never hands out a container another worker is still on, so each watch is
 * processed once and each conversation by one worker at a time. A claim a
 * dead worker left behind is cancelled by `reapStuck` on the next tick.
 *
 * ── Bounded ─────────────────────────────────────────────────────────────────
 *
 * At most CONCURRENCY watches are in flight per replica (an answer can take a
 * while; the tick does not wait for it, it only claims what the free slots
 * allow). While the engine's circuit breaker is open (the gate failed several
 * times in a row) nothing is claimed; the watches wait for it to close.
 * Finished watches, old decisions and old feedback are pruned once an hour.
 *
 * tick() never throws; start() from boot/startupTasks.js with an unref'd
 * interval, so the job never keeps a process alive.
 */

'use strict';

const crypto = require('crypto');
const log = require('../telemetry/log');

const TICK_MS = 5_000;
const BOOT_DELAY_MS = 20_000;
const CONCURRENCY = Math.max(1, parseInt(process.env.AI_PARTICIPATION_CONCURRENCY, 10) || 4);
const STUCK_MINUTES = 5;
const PRUNE_EVERY_MS = 60 * 60_000;

/**
 * @param {object} [deps]
 * @param {object}   [deps.store]        stores/projectAiParticipationStore surface
 * @param {object}   [deps.engine]       participation engine (processWatch, surfaceNames, breakerOpen)
 * @param {number}   [deps.concurrency]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newId]
 * @param {Function} [deps.recordJobRun]
 * @param {(tick: Function) => Function} [deps.gate]  wraps the tick (default: the Projects module gate)
 */
function makeParticipationJob(deps = {}) {
    const store = () => deps.store || require('../stores/projectAiParticipationStore');
    const engine = () => deps.engine || require('../projects/participation').defaultEngine();
    const concurrency = Number.isInteger(deps.concurrency) && deps.concurrency > 0 ? deps.concurrency : CONCURRENCY;
    const now = deps.now || (() => Date.now());
    const newId = deps.newId || (() => crypto.randomUUID());
    const recordJobRun = deps.recordJobRun || ((run) => require('../telemetry/metrics').recordJobRun(run));

    let inFlight = 0;
    let ticking = false;
    let lastPrune = -Infinity;
    /** @type {Set<Promise<void>>} */
    const running = new Set();
    let timer = null;
    let bootTimer = null;

    /** One watch, to its end; the claim is always closed. */
    function launch(watch) {
        inFlight += 1;
        const started = now();
        const work = (async () => {
            let status = 'ok';
            try {
                const outcome = await engine().processWatch(watch);
                if (outcome && outcome.skipReason === 'error') status = 'error';
            } catch (err) {
                status = 'error';
                log.warn(`[AiParticipation] watch ${watch.id} crashed: ${err && err.message}`);
            } finally {
                try {
                    await store().finishWatch(watch.id, watch.claimId, 'done');
                } catch (err) {
                    log.warn(`[AiParticipation] watch ${watch.id} not closed; the reaper will: ${err && err.message}`);
                }
                inFlight -= 1;
                try { recordJobRun({ job: 'ai_participation', status, durationMs: now() - started }); } catch (_) { /* metrics are optional */ }
            }
        })();
        running.add(work);
        work.finally(() => running.delete(work));
    }

    /**
     * Claim what is due, as far as the free slots allow. Never throws.
     * @returns {Promise<{ claimed: number, reaped?: number, paused?: boolean, error?: boolean }>}
     */
    async function tick() {
        if (ticking) return { claimed: 0 };
        ticking = true;
        try {
            const reaped = await store().reapStuck(STUCK_MINUTES);
            if (reaped) log.warn(`[AiParticipation] released ${reaped} watch(es) a stopped worker left claimed`);
            if (now() - lastPrune >= PRUNE_EVERY_MS) {
                lastPrune = now();
                try {
                    const pruned = await store().prune();
                    if (pruned.decisions || pruned.watches || pruned.feedback) {
                        log.info(`[AiParticipation] pruned ${pruned.decisions} decision(s), ${pruned.watches} watch(es), ${pruned.feedback} feedback row(s)`);
                    }
                } catch (err) {
                    log.warn(`[AiParticipation] prune failed: ${err && err.message}`);
                }
            }
            const eng = engine();
            if (eng.breakerOpen()) return { claimed: 0, reaped, paused: true };
            const free = concurrency - inFlight;
            if (free <= 0) return { claimed: 0, reaped };
            const due = await store().claimDue(free, { surfaces: eng.surfaceNames(), claimId: newId() });
            for (const watch of due) launch(watch);
            return { claimed: due.length, reaped };
        } catch (err) {
            log.warn(`[AiParticipation] tick failed: ${err && err.message}`);
            return { claimed: 0, error: true };
        } finally {
            ticking = false;
        }
    }

    /** Wait for every watch in flight (tests, shutdown). */
    async function drain() {
        while (running.size > 0) await Promise.allSettled([...running]);
    }

    /**
     * Start ticking. The tick goes through the module gate, so switching the
     * Projects module off in the admin panel stops the job without a restart
     * (the boot gate only reads the deploy-time catalog).
     */
    function start() {
        if (timer) return;
        const gated = deps.gate
            ? deps.gate(tick)
            : require('../modules').moduleGatedTick('projects', tick, 'aiParticipation');
        log.info(`[AiParticipation] started: every ${TICK_MS / 1000}s, up to ${concurrency} at a time`);
        timer = setInterval(() => { Promise.resolve(gated()).catch(() => {}); }, TICK_MS);
        timer.unref?.();
        bootTimer = setTimeout(() => { Promise.resolve(gated()).catch(() => {}); }, BOOT_DELAY_MS);
        bootTimer.unref?.();
    }

    function stop() {
        if (timer) clearInterval(timer);
        if (bootTimer) clearTimeout(bootTimer);
        timer = null;
        bootTimer = null;
    }

    return { tick, drain, start, stop, inFlight: () => inFlight };
}

let shared = null;
function defaultJob() {
    if (!shared) shared = makeParticipationJob();
    return shared;
}

module.exports = {
    TICK_MS,
    CONCURRENCY,
    STUCK_MINUTES,
    makeParticipationJob,
    start: () => defaultJob().start(),
    stop: () => defaultJob().stop(),
    tick: () => defaultJob().tick(),
};

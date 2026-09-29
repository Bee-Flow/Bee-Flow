/**
 * Knowledge-base source refresh — the scheduled half of "sources keep
 * themselves up to date".
 *
 * Walks kb_sources for rows whose next_refresh_at has passed and runs each
 * through core/kb/sources.syncSource. The other two triggers — someone
 * pressing "Refresh now", and (from K7 on) an external event — set the same
 * `next_refresh_at` and land in the same engine, so a source does at three in
 * the morning exactly what its owner saw when they tested it.
 *
 * Multi-replica safety is TWO mechanisms, and they do different jobs:
 *   - the advisory lock stops both replicas doing the same scanning work;
 *   - `claimDue` is what actually prevents double-running, because it flips
 *     each row to 'refreshing' in the same statement that selects it
 *     (FOR UPDATE SKIP LOCKED). The lock is an optimisation; the claim is the
 *     correctness.
 *
 * THE REAPER IS NOT OPTIONAL. A worker that dies mid-refresh leaves its row
 * in 'refreshing' with nothing to release it, and `claimDue` skips it — so
 * without `timeoutStuck` one crash takes a source offline permanently, and
 * the symptom (a source that silently stops updating) looks exactly like a
 * source nobody has touched. It runs every tick, before the claim.
 *
 * THE PER-TICK CEILING MATTERS. A crawl source with 500 pages must not hold
 * this tick — and every source behind it — open for an hour. Each pass gets
 * a time budget and an item ceiling; whatever is left stays due, so the next
 * tick continues rather than starting over.
 */

const { pool } = require('../db');
const kbSourcesStore = require('../stores/kbSources');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

/**
 * A key of its own. 0xBEEF105–0xBEEF10E are taken by the other jobs
 * (see the ticks each holds); sharing one would mean two unrelated jobs
 * silently taking turns.
 */
const LOCK_KEY = 0xBEEF10F;
const INTERVAL_MS = 60 * 1000;          // the finest schedule granularity is a minute
const BOOT_DELAY_MS = 50 * 1000;        // after the app-connector job, not with it
const MAX_PER_TICK = parseInt(process.env.KB_SOURCE_REFRESH_PER_TICK, 10) || 20;
const REFRESH_CONCURRENCY = parseInt(process.env.KB_SOURCE_REFRESH_CONCURRENCY, 10) || 3;
const STUCK_MINUTES = parseInt(process.env.KB_SOURCE_REFRESH_STUCK_MINUTES, 10) || 15;
/** One source's share of a 60s tick, with room for three of them at once. */
const TIME_BUDGET_MS = parseInt(process.env.KB_SOURCE_REFRESH_BUDGET_MS, 10) || 45_000;

/** Version rows to keep per document, and for how long — pruned from the tick. */
const VERSION_KEEP_PER_DOC = 3;
const VERSION_MAX_AGE_DAYS = 30;

let _inFlight = false;
let _timer = null;

/**
 * Refresh one claimed source and release the claim.
 *
 * Always calls `finish`: a claim that is never released is a source that
 * never refreshes again until the reaper notices, which is fifteen minutes
 * of silence for something that failed in one.
 */
async function refreshOne(source, { sources = require('../core/kb/sources'), store = kbSourcesStore } = {}) {
    try {
        const result = await sources.syncSource(source, {
            reason: 'schedule',
            timeBudgetMs: TIME_BUDGET_MS,
        });
        await store.finish(source.id, {
            ok: true,
            // A pass that stopped early is still due: leave it at now() so the
            // next tick continues it rather than waiting for the schedule.
            nextRefreshAt: (result.truncated || result.cancelled)
                ? new Date().toISOString()
                : result.nextRefreshAt,
        });
        return { ok: true, result };
    } catch (e) {
        // The engine swallows per-document failures, so reaching here means
        // the whole pass failed — a dead host, a revoked credential. finish()
        // bumps the streak, and nextRefreshFor widens the gap from it.
        const next = sources.nextRefreshFor(source, {
            consecutiveErrors: (Number(source.consecutiveErrors) || 0) + 1,
        });
        await store.finish(source.id, { ok: false, error: e, nextRefreshAt: next });
        return { ok: false, error: e.message };
    }
}

async function processDueSources() {
    if (_inFlight) return;
    _inFlight = true;
    let client = null;
    let acquired = false;
    const t0 = Date.now();
    let ok = true;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another replica owns this tick

        // Before the claim: a row a dead worker left behind is invisible to
        // claimDue until this releases it.
        const reaped = await kbSourcesStore.timeoutStuck(STUCK_MINUTES);
        if (reaped) log.warn(`[KBSourceRefresh] reaped ${reaped} stuck source(s)`);

        // Also before the claim, so anything it arms is picked up by THIS tick
        // rather than waiting a minute for the next one.
        await armStaleLiveSources();

        const due = await kbSourcesStore.claimDue(MAX_PER_TICK);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, due.length) }, async () => {
            for (;;) {
                const i = cursor++;
                if (i >= due.length) return;
                const r = await refreshOne(due[i]);
                if (!r.ok) ok = false;
            }
        });
        await Promise.all(workers);

        // Version history has no delete path of its own, so the tick is where
        // it is bounded. Best-effort: a failed prune must not fail the tick.
        try {
            const kbStore = require('../stores/knowledgeBases');
            if (typeof kbStore.pruneDocumentVersions === 'function') {
                await kbStore.pruneDocumentVersions(VERSION_KEEP_PER_DOC, VERSION_MAX_AGE_DAYS);
            }
        } catch (e) {
            log.warn('[KBSourceRefresh] version prune failed:', e.message);
        }
    } catch (e) {
        ok = false;
        log.warn('[KBSourceRefresh] tick error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired) recordJobRun({ job: 'kb_source_refresh', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        _inFlight = false;
    }
}

function start() {
    if (_timer) return;
    log.info(`[KBSourceRefresh] started: every ${INTERVAL_MS / 1000}s, up to ${MAX_PER_TICK} per tick, ${REFRESH_CONCURRENCY} at a time`);
    _timer = setInterval(() => {
        processDueSources().catch((e) => log.warn('[KBSourceRefresh] tick error:', e && e.message));
    }, INTERVAL_MS);
    _timer.unref?.();
    setTimeout(() => {
        processDueSources().catch((e) => log.warn('[KBSourceRefresh] boot tick error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

/**
 * A datatable's rows moved — arm the `live` sources watching it (K8).
 *
 * Called from `datatableStore`'s write path, debounced there so a routine
 * looping over 400 rows produces one pass rather than 400. Arms only; the tick
 * does the work under the lock and the time budget it already has.
 */
async function onDatatableChanged(datatableId, { store = kbSourcesStore } = {}) {
    if (!datatableId) return 0;
    try {
        const armed = await store.armDatatableSources(datatableId);
        if (armed > 0) log.info(`[KBSourceRefresh] datatable ${datatableId} armed ${armed} live source(s)`);
        return armed;
    } catch (e) {
        log.warn('[KBSourceRefresh] could not arm datatable sources:', e.message);
        return 0;
    }
}

/**
 * The backstop for "live" (K8).
 *
 * ── WHY THE WRITE-PATH HOOK IS NOT ENOUGH ───────────────────────────
 * `notifyDatatableChanged` is an in-process timer. It does not survive a
 * restart, it does not cross a replica, and a write from a job on another pod
 * fires nobody's timer here. A source that missed its notification would sit
 * on stale rows until somebody pressed refresh — and "live" would be a label
 * with nothing behind it.
 *
 * So the tick compares the version each source last covered against the
 * table's current `data_version`, and arms the ones that fell behind. The
 * version is the right comparison rather than a timestamp: it is bumped by
 * every write path there is, including the retention sweep, and it cannot go
 * backwards or be confused by a clock.
 *
 * Best-effort throughout: a backstop that fails must not fail the tick that
 * carries every other source.
 */
async function armStaleLiveSources({ store = kbSourcesStore, datatables = null } = {}) {
    let sources = [];
    try {
        sources = await store.listLiveDatatableSources();
    } catch (e) {
        log.warn('[KBSourceRefresh] live backstop unavailable:', e.message);
        return 0;
    }
    const pending = sources.filter(s => s.datatableId && !s.nextRefreshAt);
    if (pending.length === 0) return 0;

    const dtStore = datatables || require('../stores/datatableStore');
    let armed = 0;
    const versions = new Map();
    const versionOf = async (tableId) => {
        if (!versions.has(tableId)) versions.set(tableId, await currentDataVersion(dtStore, tableId));
        return versions.get(tableId);
    };
    for (const source of pending) {
        try {
            const current = await versionOf(source.datatableId);
            // `null` is "the table is gone or unreadable from here". NOT a
            // reason to arm: the pass would fail the same way, every minute.
            let behind = current !== null && current > source.seenDataVersion;
            // The tables its relation columns point at, whose labels this
            // source renders: a rename or an erasure there is a change HERE.
            // A related table that cannot be read is skipped for the same
            // reason as above; the source's own table decides on its own.
            for (const related of (source.relatedTableIds || [])) {
                if (behind) break;
                const v = await versionOf(related);
                if (v === null) continue;
                const seen = Number(source.seenRelatedVersions?.[related]) || 0;
                if (v > seen) behind = true;
            }
            if (!behind) continue;
            await store.requestRefresh(source.id);
            armed += 1;
        } catch (e) {
            log.warn(`[KBSourceRefresh] live backstop skipped source ${source.id}:`, e.message);
        }
    }
    if (armed) log.info(`[KBSourceRefresh] live backstop armed ${armed} source(s)`);
    return armed;
}

/** A table's current `data_version`, or null when it cannot be read. */
async function currentDataVersion(dtStore, datatableId) {
    try {
        if (typeof dtStore.getDataVersion === 'function') {
            const v = await dtStore.getDataVersion(datatableId);
            return v === null || v === undefined ? null : Number(v) || 0;
        }
        return null;
    } catch (_) {
        return null;
    }
}

/**
 * A meeting finished — arm the sources that watch its tags (K7).
 *
 * ── ARM, DO NOT REFRESH ─────────────────────────────────────────────
 * This sets `next_refresh_at = now()` and returns. It does NOT run the pass
 * inline, for two reasons that both matter:
 *
 *   • The caller is a meeting ingest, and its note is already saved. Making
 *     that request wait on an embedding pass would slow the thing a person is
 *     watching for the benefit of a background one they are not.
 *   • The job already holds the advisory lock, the concurrency limit and the
 *     time budget. Ten meetings ending in one minute would otherwise be ten
 *     concurrent embedding passes with nothing holding them back.
 *
 * Never throws: it is a tap on an event bus, and a knowledge base that fails
 * to arm refreshes on its own schedule anyway.
 *
 * @param {{ tags?: string[] }} payload  the `meeting.processed` payload
 * @returns {Promise<number>} sources armed
 */
async function onMeetingProcessed(payload, { store = kbSourcesStore } = {}) {
    const tags = Array.isArray(payload?.tags) ? payload.tags : [];
    if (tags.length === 0) return 0;
    try {
        const armed = await store.armMeetingSources(tags);
        if (armed > 0) {
            log.info(`[KBSourceRefresh] meeting.processed armed ${armed} source(s) for tags [${tags.join(', ')}]`);
        }
        return armed;
    } catch (e) {
        log.warn('[KBSourceRefresh] could not arm meeting sources:', e.message);
        return 0;
    }
}

module.exports = {
    start, processDueSources, refreshOne, onMeetingProcessed,
    onDatatableChanged, armStaleLiveSources,
    LOCK_KEY, MAX_PER_TICK, REFRESH_CONCURRENCY, STUCK_MINUTES, TIME_BUDGET_MS,
};

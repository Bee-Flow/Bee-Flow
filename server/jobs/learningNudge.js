/**
 * Learning Center weekly review nudge (daily tick).
 *
 * The retention layer (v2) only works if learners come back: this job posts a
 * gentle notification-center nudge to users who STARTED learning, aren't done,
 * and have gone quiet — "a 5-minute review keeps it stuck". It deliberately
 * targets the lapsed middle, never the active (they don't need it) and never
 * the long-gone (nudging a 3-month absence is spam, not teaching).
 *
 * Candidates come straight from the progress blobs
 * (configStore `learning_progress_user_<id>` — only users who ever started),
 * so there is no full users-table sweep. Dedup: max one nudge per user per
 * 14 days via a configStore marker (`learning_nudge_last_<userId>`), advanced
 * only after a notification actually landed — the ncOnboardingReminder
 * contract. Multi-replica safety via a Postgres advisory lock, the
 * opsMetricsPush pattern: every pod ticks, one wins.
 *
 * run() never throws (scheduler-safe). start() from server/index.js,
 * staggered first run, unref'd interval.
 */

const { pool } = require('../db');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_IDLE_DAYS = 7;      // quiet at least this long before we nudge
const NUDGE_GIVE_UP_DAYS = 60;  // quiet longer than this → stop nudging entirely
const REPEAT_EVERY_DAYS = 14;   // max one nudge per user per two weeks
const TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_USERS_PER_TICK = 500; // bound one tick's work; the rest catch the next day
// Bounds NOTIFICATIONS, which MAX_USERS_PER_TICK does not: that one bounds how
// many blobs we read. Without this, any day on which many users happen to cross
// the 7-day line together lands as one burst in everyone's bell at once.
const MAX_NUDGES_PER_TICK = 50;

const MARKER_PREFIX = 'learning_nudge_last_';
const PROGRESS_PREFIX = 'learning_progress_user_';
const LOCK_KEY = 0xBEEF10D; // unique among jobs/* advisory locks

// The freshest timestamp anywhere in a progress blob — completions, mastery,
// or graded step activity. Null when the blob carries no usable timestamps
// (e.g. only legacy `true` entries) — those users are skipped, not guessed at.
function _lastActivityAt(progress) {
    let last = null;
    for (const entry of Object.values(progress || {})) {
        if (!entry || typeof entry !== 'object') continue;
        const stamps = [entry.completedAt, entry.masteredAt];
        for (const step of Object.values(entry.steps || {})) {
            if (step && typeof step === 'object') stamps.push(step.answeredAt, step.reviewedAt);
        }
        for (const s of stamps) {
            const ts = typeof s === 'string' ? Date.parse(s) : NaN;
            if (Number.isFinite(ts) && (!last || ts > last)) last = ts;
        }
    }
    return last;
}

// Pure eligibility: started, not finished with every course, and lapsed —
// idle between NUDGE_IDLE_DAYS and NUDGE_GIVE_UP_DAYS.
function _isEligible(progress, now) {
    if (!progress || typeof progress !== 'object' || !Object.keys(progress).length) return false;
    const { courseComplete } = require('../learning/completion');
    const { COURSES } = require('../learning/courseCatalog');
    if (COURSES.every((c) => courseComplete(c, progress))) return false; // graduated
    const last = _lastActivityAt(progress);
    if (!last) return false;
    const idle = now - last;
    return idle > NUDGE_IDLE_DAYS * DAY_MS && idle < NUDGE_GIVE_UP_DAYS * DAY_MS;
}

async function run({ now = Date.now() } = {}) {
    const result = { checked: 0, notified: 0, seeded: 0, skipped: 0, errors: 0 };
    const configStore = require('../stores/configStore');

    let keys;
    try {
        keys = await configStore.listKeysWithPrefix(PROGRESS_PREFIX);
    } catch (err) {
        log.warn(`[learningNudge] Could not list progress keys: ${err.message}`);
        return result;
    }

    // ── First tick on an existing install: SEED, do not nudge. ──────────
    // Eligibility is "lapsed 7-60 days", and on the very first run of this job
    // that describes a BACKLOG, not an event: every learner who drifted off in
    // the last two months qualifies at the same instant, and none of them has a
    // dedup marker yet. On an install with real history that is a notification
    // blast 12 minutes after boot — hundreds of bells at once, for nothing the
    // recipient just did. It also catches people who had finished every course
    // that existed, because two new ones shipped and courseComplete() is
    // therefore false for them again.
    //
    // So when no marker exists ANYWHERE, write markers and send nothing. The
    // job then behaves normally from the next tick on, nudging people as they
    // genuinely cross the threshold. The cost is that a currently-lapsed
    // learner waits one REPEAT_EVERY_DAYS window for their first nudge, which
    // is the right trade against mailing the entire backlog on release day.
    let seeding = false;
    try {
        const markers = await configStore.listKeysWithPrefix(MARKER_PREFIX);
        seeding = !(markers && markers.length);
    } catch (err) {
        // Can't prove it's a cold start → assume it is NOT, so a transient
        // listing failure can never turn into the blast this guard prevents.
        log.warn(`[learningNudge] marker listing failed, skipping this tick: ${err.message}`);
        return result;
    }

    for (const key of (keys || []).slice(0, MAX_USERS_PER_TICK)) {
        const userId = key.slice(PROGRESS_PREFIX.length);
        if (!userId) continue;
        result.checked++;
        if (result.notified >= MAX_NUDGES_PER_TICK && !seeding) {
            result.skipped++;
            continue;
        }
        try {
            // Dedup first — cheaper than reading the blob.
            const marker = await configStore.getConfig(`${MARKER_PREFIX}${userId}`);
            if (marker) {
                const lastNudge = new Date(String(marker)).getTime();
                if (Number.isFinite(lastNudge) && (now - lastNudge) < REPEAT_EVERY_DAYS * DAY_MS) {
                    result.skipped++;
                    continue;
                }
            }

            const progress = await configStore.getConfig(key);
            if (!_isEligible(progress, now)) {
                result.skipped++;
                continue;
            }

            if (seeding) {
                // Baseline only — the marker without the bell.
                await configStore.setConfig(`${MARKER_PREFIX}${userId}`, new Date(now).toISOString());
                result.seeded++;
                continue;
            }

            await require('../stores/notificationStore').createNotification({
                userId,
                category: 'learning',
                title: 'A 5-minute review keeps it stuck',
                message: 'You have lessons waiting in the Learning Center — a short review of what you '
                    + 'learned is exactly how it becomes second nature. Pick up where you left off.',
                link: require('../utils/appPaths').learningSettingsPath(),
            });
            result.notified++;
            // Marker only after the notification actually landed.
            await configStore.setConfig(`${MARKER_PREFIX}${userId}`, new Date(now).toISOString());
        } catch (err) {
            result.errors++;
            log.warn(`[learningNudge] user=${userId} error: ${err.message}`);
        }
    }

    if (result.seeded > 0) {
        log.info(`[learningNudge] first run on this install — seeded ${result.seeded} marker(s), nudged nobody`);
    }
    if (result.notified > 0) {
        log.info(`[learningNudge] nudged=${result.notified} skipped=${result.skipped} errors=${result.errors}`);
    }
    return result;
}

// Advisory-locked entrypoint — safe to call from every pod; only one wins.
async function _tick() {
    let acquired = false;
    let client;
    const t0 = Date.now();
    let ok = true;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        // Removing Learning from the admin Modules panel has to stop the
        // nudges too, not just hide the routes — a notification for a section
        // the instance no longer has is the worst kind. Runtime row, not the
        // boot-time catalog flag; fails open.
        try {
            if (!await require('../modules').isModuleActive('learning')) return;
        } catch (_) { /* fail open — a state read blip must not stop the job */ }
        await run();
    } catch (e) {
        ok = false;
        log.warn('[learningNudge] tick failed (will retry tomorrow):', e && e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired) recordJobRun({ job: 'learning_nudge', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
    }
}

let _interval = null;

function start() {
    if (_interval) return;
    // Stagger first run by 12 min after boot so we don't compete with init load.
    setTimeout(() => { _tick().catch(() => { }); }, 12 * 60 * 1000).unref?.();
    _interval = setInterval(() => { _tick().catch(() => { }); }, TICK_INTERVAL_MS);
    if (typeof _interval.unref === 'function') _interval.unref();
    log.info('[learningNudge] Scheduled (daily; lapsed 7-60d learners; 1 nudge/user/14d)');
}

function stop() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}

module.exports = { start, stop, run, _isEligible, _lastActivityAt, MARKER_PREFIX };

'use strict';
/**
 * Startup task: keep the Learning Center video pack in LEARN_MEDIA_DIR on the
 * version this release pins (learnMediaPack.json, see learnMediaInstall.js).
 *
 * The server fetches the pack itself, from the Bee Flow GitHub release, so a
 * self-hosted install gets its lesson videos without an operator step. The
 * browser still only talks to this server (GET /learn-media/*).
 *
 *   • off when NODE_ENV=test, or LEARN_MEDIA_AUTO is off / false / 0 (air-gapped
 *     installs use `npm run learn-media:fetch -- <tarball>` instead);
 *   • starts ~15 s after boot on an unref'd timer, so boot never waits for it;
 *   • no pin file (a build without a published pack) = quiet skip;
 *   • one run at a time per directory: a lock file created with O_EXCL under a
 *     dot name (never served), taken over once it is an hour old, which is how
 *     a crashed run stops blocking the next one. Replicas that share a volume
 *     therefore do not download the same pack twice;
 *   • a failed run is retried after 1 min, 5 min, 30 min, then every 6 h.
 *
 * Nothing here throws into startup, and a failure only costs the lesson videos.
 */

const fs = require('node:fs');
const path = require('node:path');

const log = require('../telemetry/log');
const { learnMediaDir } = require('./learnMedia');
const { syncFromPin } = require('./learnMediaInstall');

const PIN_PATH = path.join(__dirname, 'learnMediaPack.json');
const LOCK_NAME = '.learn-media-sync.lock';
const START_DELAY_MS = 15_000;
const LOCK_STALE_MS = 60 * 60 * 1000;
const RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000]);
const RETRY_FOREVER_MS = 6 * 60 * 60 * 1000;

/** Why the task is off, or '' when it should run. */
function disabledReason(env = process.env) {
    if (env.NODE_ENV === 'test') return 'NODE_ENV=test';
    if (['off', 'false', '0'].includes(String(env.LEARN_MEDIA_AUTO ?? '').trim().toLowerCase())) return 'LEARN_MEDIA_AUTO is off';
    return '';
}

/**
 * Take the lock, or return null when another run holds it. A lock older than
 * `staleMs` is taken over. Returns a release function.
 */
function acquireLock(dir, { staleMs = LOCK_STALE_MS, now = Date.now, fsImpl = fs } = {}) {
    fsImpl.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, LOCK_NAME);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fsImpl.openSync(lock, 'wx');
            try { fsImpl.writeSync(fd, `${process.pid}\n`); } finally { fsImpl.closeSync(fd); }
            return () => { try { fsImpl.unlinkSync(lock); } catch { /* already gone */ } };
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            let age = 0;
            try { age = now() - fsImpl.statSync(lock).mtimeMs; } catch { continue; } // vanished: try again
            if (age < staleMs) return null;
            try { fsImpl.unlinkSync(lock); } catch { /* someone else took it over */ }
        }
    }
    return null;
}

function readPin(pinPath = PIN_PATH, fsImpl = fs) {
    let raw;
    try {
        raw = fsImpl.readFileSync(pinPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    return JSON.parse(raw);
}

/**
 * Build the task. Every dependency is injectable for tests. `start()` returns
 * true when a first run was scheduled.
 */
function createLearnMediaSync({
    env = process.env,
    dir = learnMediaDir(env),
    pinPath = PIN_PATH,
    sync = syncFromPin,
    logger = log,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
    fsImpl = fs,
    startDelayMs = START_DELAY_MS,
    lockStaleMs = LOCK_STALE_MS,
} = {}) {
    let failures = 0;
    let timer = null;
    let stopped = false;
    let running = false;

    const schedule = (ms) => {
        if (stopped) return;
        timer = setTimer(() => { timer = null; void runOnce(); }, ms);
        timer?.unref?.();
    };

    /** One attempt. Resolves with a status string; never rejects. */
    async function runOnce() {
        if (running) return 'busy';
        running = true;
        let release = null;
        try {
            let pin;
            try {
                pin = readPin(pinPath, fsImpl);
            } catch (err) {
                logger.warn(`learn media pin unreadable: ${err.message}`);
                return 'bad-pin'; // a broken file does not heal by retrying
            }
            if (!pin) {
                logger.debug('learn media: no pack pinned in this build, skipping');
                return 'no-pin';
            }
            release = acquireLock(dir, { staleMs: lockStaleMs, now, fsImpl });
            if (!release) {
                logger.debug('learn media: another run holds the lock, skipping');
                return 'locked';
            }
            const result = await sync(pin, dir, { log: (m) => logger.debug(`learn media: ${m}`) });
            failures = 0;
            if (result.status === 'installed') {
                logger.info(`learn media installed ${result.version} (${result.downloaded} downloaded, ${result.reused} reused)`);
            } else {
                logger.debug(`learn media ${result.version} is up to date`);
            }
            return result.status;
        } catch (err) {
            const delay = failures < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[failures] : RETRY_FOREVER_MS;
            failures += 1;
            logger.warn(`learn media install failed (retrying in ${Math.round(delay / 60_000)} min): ${err.message}`);
            schedule(delay);
            return 'failed';
        } finally {
            if (release) release();
            running = false;
        }
    }

    function start() {
        try {
            const reason = disabledReason(env);
            if (reason) {
                logger.debug(`learn media sync off (${reason})`);
                return false;
            }
            schedule(startDelayMs);
            return true;
        } catch (err) {
            logger.warn(`learn media sync could not start: ${err.message}`);
            return false;
        }
    }

    function stop() {
        stopped = true;
        if (timer) clearTimer(timer);
        timer = null;
    }

    return { start, stop, runOnce };
}

/** Called from boot/startupTasks.js. */
function startLearnMediaSync() {
    return createLearnMediaSync().start();
}

module.exports = { startLearnMediaSync, createLearnMediaSync, disabledReason, acquireLock, readPin, PIN_PATH, LOCK_NAME, RETRY_DELAYS_MS, RETRY_FOREVER_MS };

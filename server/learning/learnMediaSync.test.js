/**
 * The learnMediaSync startup task: when it runs, the lock, the retry schedule.
 *
 * Run: cd server && node --test learning/learnMediaSync.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLearnMediaSync, disabledReason, acquireLock, LOCK_NAME, RETRY_DELAYS_MS, RETRY_FOREVER_MS } = require('./learnMediaSync');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-media-sync-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const scratch = () => path.join(tmpRoot, `d${++n}`);

const PIN = { version: 'v1', manifest: 'm.json', manifestSha256: 'a'.repeat(64), baseUrl: 'https://example.com/', videoIds: [] };
function pinFile() {
    const p = path.join(tmpRoot, `pin${++n}.json`);
    fs.writeFileSync(p, JSON.stringify(PIN));
    return p;
}

function recorder() {
    const lines = [];
    const mk = (level) => (msg) => lines.push([level, msg]);
    return { lines, logger: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') } };
}

/** Fake timers: record (fn, ms), fire on demand. */
function fakeTimers() {
    const pending = [];
    return {
        pending,
        setTimer: (fn, ms) => { const t = { fn, ms, unref() { t.unrefd = true; return t; } }; pending.push(t); return t; },
        clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
        fire: async () => { const t = pending.shift(); t.fn(); await new Promise((r) => setImmediate(r)); return t; },
    };
}

test('disabledReason: tests and LEARN_MEDIA_AUTO off in any spelling', () => {
    assert.ok(disabledReason({ NODE_ENV: 'test' }));
    for (const v of ['off', 'OFF', 'false', 'False', '0', ' off ']) assert.ok(disabledReason({ LEARN_MEDIA_AUTO: v }), v);
    for (const v of [undefined, '', 'on', '1', 'auto']) assert.strictEqual(disabledReason({ LEARN_MEDIA_AUTO: v }), '', String(v));
});

test('start() schedules nothing when disabled, and an unref\'d first run after the delay when enabled', () => {
    const t = fakeTimers();
    const off = createLearnMediaSync({ env: { LEARN_MEDIA_AUTO: 'off' }, setTimer: t.setTimer, ...recorder() });
    assert.strictEqual(off.start(), false);
    assert.strictEqual(t.pending.length, 0);

    const on = createLearnMediaSync({ env: {}, dir: scratch(), setTimer: t.setTimer, clearTimer: t.clearTimer, ...recorder() });
    assert.strictEqual(on.start(), true);
    assert.strictEqual(t.pending.length, 1);
    assert.strictEqual(t.pending[0].ms, 15_000);
    assert.ok(t.pending[0].unrefd);
    on.stop();
    assert.strictEqual(t.pending.length, 0);
});

test('a missing pin skips quietly', async () => {
    const { lines, logger } = recorder();
    let called = false;
    const task = createLearnMediaSync({ env: {}, dir: scratch(), pinPath: path.join(tmpRoot, 'nope.json'), sync: async () => { called = true; }, logger });
    assert.strictEqual(await task.runOnce(), 'no-pin');
    assert.strictEqual(called, false);
    assert.ok(lines.every(([level]) => level === 'debug'));
});

test('success logs the install line; up to date logs only at debug', async () => {
    const { lines, logger } = recorder();
    const results = [{ status: 'installed', version: 'v1', downloaded: 3, reused: 2, bytes: 9 }, { status: 'up-to-date', version: 'v1' }];
    const task = createLearnMediaSync({ env: {}, dir: scratch(), pinPath: pinFile(), sync: async () => results.shift(), logger });
    assert.strictEqual(await task.runOnce(), 'installed');
    assert.deepStrictEqual(lines.filter(([l]) => l === 'info'), [['info', 'learn media installed v1 (3 downloaded, 2 reused)']]);
    assert.strictEqual(await task.runOnce(), 'up-to-date');
    assert.strictEqual(lines.filter(([l]) => l === 'info').length, 1);
});

test('a second concurrent run skips while the first holds the lock, and the lock is released after', async () => {
    const dir = scratch();
    const { logger } = recorder();
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const mk = () => createLearnMediaSync({ env: {}, dir, pinPath: pinFile(), logger, sync: async () => { calls += 1; await gate; return { status: 'installed', version: 'v1', downloaded: 0, reused: 0 }; } });
    const first = mk().runOnce();
    await new Promise((r) => setImmediate(r));
    assert.ok(fs.existsSync(path.join(dir, LOCK_NAME)));
    assert.strictEqual(await mk().runOnce(), 'locked');
    release();
    assert.strictEqual(await first, 'installed');
    assert.strictEqual(calls, 1);
    assert.ok(!fs.existsSync(path.join(dir, LOCK_NAME)), 'lock released');
});

test('a stale lock (over an hour old) is taken over, a fresh one is not', () => {
    const dir = scratch();
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, LOCK_NAME);
    fs.writeFileSync(lock, '999\n');
    assert.strictEqual(acquireLock(dir), null);
    const old = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    const release = acquireLock(dir);
    assert.strictEqual(typeof release, 'function');
    assert.ok(fs.existsSync(lock));
    release();
    assert.ok(!fs.existsSync(lock));
});

test('failures retry after 1 min, 5 min, 30 min, then every 6 h; success resets the schedule', async () => {
    const t = fakeTimers();
    const { lines, logger } = recorder();
    let fail = true;
    const task = createLearnMediaSync({
        env: {}, dir: scratch(), pinPath: pinFile(), logger, setTimer: t.setTimer, clearTimer: t.clearTimer,
        sync: async () => { if (fail) throw new Error('offline'); return { status: 'installed', version: 'v1', downloaded: 1, reused: 0 }; },
    });
    assert.strictEqual(await task.runOnce(), 'failed');
    const seen = [t.pending[0].ms];
    for (let i = 0; i < 4; i += 1) { await t.fire(); seen.push(t.pending[0].ms); }
    assert.deepStrictEqual(seen, [...RETRY_DELAYS_MS, RETRY_FOREVER_MS, RETRY_FOREVER_MS]);
    assert.deepStrictEqual(RETRY_DELAYS_MS, [60_000, 300_000, 1_800_000]);
    assert.ok(t.pending.every((p) => p.unrefd));
    assert.ok(lines.some(([l, m]) => l === 'warn' && /offline/.test(m)));

    fail = false;
    await t.fire();
    assert.strictEqual(t.pending.length, 0, 'no further retry after success');
    fail = true;
    assert.strictEqual(await task.runOnce(), 'failed');
    assert.strictEqual(t.pending[0].ms, 60_000, 'the schedule starts over');
});

test('an unreadable pin is a warning and never throws', async () => {
    const bad = path.join(tmpRoot, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    const { lines, logger } = recorder();
    const task = createLearnMediaSync({ env: {}, dir: scratch(), pinPath: bad, logger, sync: async () => { throw new Error('unreached'); } });
    assert.strictEqual(await task.runOnce(), 'bad-pin');
    assert.ok(lines.some(([l]) => l === 'warn'));
});

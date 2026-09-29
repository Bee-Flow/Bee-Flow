/**
 * Maintenance window store — unit tests.
 *
 * Run: node --test core/maintenanceWindow.test.js
 *
 * configStore is stubbed out of require.cache (same trick as
 * firefliesTools.test.js) so this needs no DB.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Stub configStore before the module under test requires it ──────────
const configStorePath = require.resolve('../../stores/configStore');
let _store = Object.create(null);
let _failRead = false;
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        getConfig: async (k) => {
            if (_failRead) throw new Error('db is down');
            return _store[k];
        },
        setConfig: async (k, v) => { _store[k] = v; },
    },
};

const mw = require('./maintenanceWindow');

function reset() { _store = Object.create(null); _failRead = false; }

// ── _clampEta ──────────────────────────────────────────────────────────

test('_clampEta holds a sane ETA unchanged', () => {
    assert.strictEqual(mw._clampEta(180), 180);
});

test('_clampEta floors absurdly short windows', () => {
    assert.strictEqual(mw._clampEta(1), mw.MIN_ETA_SECONDS);
});

test('_clampEta caps a typo that would outlive the outage', () => {
    // 999999s is eleven days; the banner must not promise that.
    assert.strictEqual(mw._clampEta(999999), mw.MAX_ETA_SECONDS);
});

test('_clampEta rejects non-numbers rather than coercing them', () => {
    // null/''/[]/true all pass Number.isFinite(Number(x)) as 0 or 1. Without a
    // type guard a missing ETA becomes a 10s window and announces an outage
    // nobody requested — this asserts the guard, not the arithmetic.
    for (const bad of [undefined, null, 'soon', NaN, {}, '', [], true, false]) {
        assert.strictEqual(mw._clampEta(bad), null, `expected null for ${JSON.stringify(bad) ?? String(bad)}`);
    }
});

test('_clampEta accepts a numeric string, as a JSON body delivers it', () => {
    assert.strictEqual(mw._clampEta('180'), 180);
});

test('_clampEta rounds fractional seconds', () => {
    assert.strictEqual(mw._clampEta(120.6), 121);
});

// ── _isActive ──────────────────────────────────────────────────────────

test('_isActive is true strictly before endsAt and false at/after it', () => {
    const win = { endsAt: new Date(1000).toISOString() };
    assert.strictEqual(mw._isActive(win, 999), true);
    assert.strictEqual(mw._isActive(win, 1000), false, 'the boundary itself is over');
    assert.strictEqual(mw._isActive(win, 1001), false);
});

test('_isActive rejects garbage instead of treating it as forever-active', () => {
    for (const bad of [null, undefined, {}, { endsAt: 'nonsense' }, 'string']) {
        assert.strictEqual(mw._isActive(bad, 0), false);
    }
});

// ── announce / getActiveWindow / clear ─────────────────────────────────

test('announce stores a window that reads back as active', async () => {
    reset();
    const win = await mw.announce({ etaSeconds: 120, reason: 'deploy', ref: 'abc123' });
    assert.strictEqual(win.etaSeconds, 120);
    assert.strictEqual(win.reason, 'deploy');
    assert.strictEqual(win.ref, 'abc123');
    assert.ok(Date.parse(win.endsAt) > Date.parse(win.startedAt));

    const active = await mw.getActiveWindow();
    assert.ok(active, 'window should be active immediately after announcing');
    assert.strictEqual(active.ref, 'abc123');
});

test('announce rejects a missing or non-numeric ETA', async () => {
    reset();
    await assert.rejects(() => mw.announce({}), /etaSeconds/);
    await assert.rejects(() => mw.announce({ etaSeconds: 'soon' }), /etaSeconds/);
});

test('THE FAIL-OPEN GUARANTEE: an expired window reads as inactive', async () => {
    reset();
    const win = await mw.announce({ etaSeconds: 60 });
    // A deploy that crashed between announce and clear must not strand the
    // banner. Read from one second past the window's own end.
    const afterEnd = Date.parse(win.endsAt) + 1000;
    assert.strictEqual(await mw.getActiveWindow(afterEnd), null);
});

test('clear takes the window down before its ETA elapses', async () => {
    reset();
    await mw.announce({ etaSeconds: 600 });
    assert.ok(await mw.getActiveWindow());
    await mw.clear();
    assert.strictEqual(await mw.getActiveWindow(), null);
});

test('getActiveWindow returns null when nothing was ever announced', async () => {
    reset();
    assert.strictEqual(await mw.getActiveWindow(), null);
});

test('getActiveWindow swallows a store failure rather than failing the request', async () => {
    reset();
    _failRead = true;
    // The banner is a courtesy; a DB blip must not 500 the page around it.
    assert.strictEqual(await mw.getActiveWindow(), null);
});

test('getActiveWindow tolerates a corrupt stored value', async () => {
    reset();
    _store[mw.CONFIG_KEY] = 'not json{';
    assert.strictEqual(await mw.getActiveWindow(), null);
});

test('reason and ref are truncated so a rogue caller cannot bloat the banner', async () => {
    reset();
    const win = await mw.announce({ etaSeconds: 60, reason: 'x'.repeat(500), ref: 'y'.repeat(500) });
    assert.strictEqual(win.reason.length, 200);
    assert.strictEqual(win.ref.length, 200);
});

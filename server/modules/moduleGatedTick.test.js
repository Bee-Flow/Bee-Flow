/**
 * The "workers no-op" half of the module contract.
 *
 * modules/index.js has always promised three things about an inactive module:
 * routes 404, capabilities leave the registry projection, and its workers stop.
 * The first two were implemented and tested. The third was a sentence — the
 * boot-time gates in boot/startupTasks.js read isModuleAvailable(), the
 * DEPLOY-TIME catalog flag, so they decide whether a scheduler starts at all
 * and never look again. An operator removing Automations from the admin panel
 * got 404s on the routes while the 60s tick kept executing their automations.
 *
 * moduleGatedTick() closes that, and this pins its behaviour — including the
 * fail-open stance, which matters more than the gating: a database blip must
 * never silently stop the automation engine.
 *
 * Run: node --test --test-force-exit modules/moduleGatedTick.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

process.env.NODE_ENV = 'test';

// Stub ../db before the module chain loads (same idiom as catalog.test.js).
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = {
    exec: async () => ({}), run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null, getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
};
require.cache[dbPath].loaded = true;

const mods = require('./index');

/** Swap isModuleActive for the duration of fn. */
async function withActive(impl, fn) {
    const saved = Object.getOwnPropertyDescriptor(mods, 'isModuleActive');
    Object.defineProperty(mods, 'isModuleActive', { value: impl, configurable: true, writable: true });
    try { await fn(); } finally { Object.defineProperty(mods, 'isModuleActive', saved); }
}

test('moduleGatedTick is exported', () => {
    assert.strictEqual(typeof mods.moduleGatedTick, 'function');
});

test('an ACTIVE module runs its tick and passes arguments through', async () => {
    const seen = [];
    const gated = mods.moduleGatedTick('automation', async (...a) => { seen.push(a); return 'ran'; });
    const out = await gated(1, 'two');
    assert.strictEqual(out, 'ran');
    assert.deepEqual(seen, [[1, 'two']]);
});

test('an INACTIVE module does not run its tick', async () => {
    // catalog defaults make everything active, so drive it through a module id
    // the catalog does not know — resolveEntry returns null → isModuleActive
    // false — which is the same code path a removed row takes.
    let ran = 0;
    const gated = mods.moduleGatedTick('no_such_module_id', async () => { ran += 1; });
    await gated();
    await gated();
    assert.strictEqual(ran, 0, 'tick ran for a module that is not active');
});

test('it FAILS OPEN when the state read throws', async () => {
    // The property that matters most. A DB blip must not stop the engine.
    let ran = 0;
    const boom = () => { throw new Error('db down'); };
    const gated = mods.moduleGatedTick('automation', async () => { ran += 1; }, 'tick');
    await withActive(boom, async () => { await gated(); });
    assert.strictEqual(ran, 1, 'a failing state read must let the tick run, not silence it');
});

test('the schedulers actually use it — the gate is wired, not just available', () => {
    // A helper nothing calls is the same bug in a nicer shape.
    //
    // Genuinely textual, and deliberately cheap: every moduleGatedTick(...)
    // call below lives inside start(), not at module scope, so reaching it
    // for real means calling start() with cron/pool/execution/entitlements/
    // meetingNotes/jobs all stubbed — the same harness
    // core/automationRunner/scheduler/ticks.test.js already stands up for the
    // stronger reference-identity proof. This is the tripwire that lives next
    // to the gate itself and does not need that harness to catch "wired
    // nothing calls".
    const ticks = fs.readFileSync(
        path.join(__dirname, '..', 'core', 'automationRunner', 'scheduler', 'ticks.js'), 'utf8');
    assert.match(ticks, /moduleGatedTick\(/, 'automation ticks are not module-gated');
    for (const fn of ['processDueAutomations', 'reapStuckAutomations']) {
        assert.ok(
            new RegExp(`moduleGatedTick\\('automation', ${fn}`).test(ticks),
            `${fn} is not behind the automation module gate`,
        );
    }
    for (const fn of ['processTalkAutoRecord', 'processGmeetAutoImport']) {
        assert.ok(
            new RegExp(`moduleGatedTick\\('meetingNotes', ${fn}`).test(ticks),
            `${fn} is not behind the meetingNotes module gate`,
        );
    }
    const nudge = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'learningNudge.js'), 'utf8');
    assert.match(nudge, /isModuleActive\('learning'\)/, 'learningNudge does not check its module');
});

test('BFSF-433: the boot kickoffs go through the gate too, not the raw functions', () => {
    // start() fires three of the ticks once shortly after boot so the first
    // interval period isn't dead time — and retention's period is an HOUR, so
    // on a pod that restarts often that one-shot IS the retention pass.
    //
    // Those one-shots used to be wired to the RAW functions. On an instance
    // where the deploy-time catalog says Automations exists (which is all
    // boot/startupTasks.js consults before calling start()) but an admin has
    // switched the module off in the panel, every restart therefore ran one
    // ungated burst — processRunRetention included, and that one DELETEs: run
    // history, monitoring ledgers, the PII scan ledger, orphan uploads,
    // expired generated files, form sessions.
    //
    // Weak on purpose: this would still pass for `setTimeout(() => fn(), …)`.
    // The real proof is reference identity between each kickoff callback and
    // the interval's — see core/automationRunner/scheduler/ticks.test.js. This
    // is the cheap tripwire that lives next to the gate it protects.
    const ticks = fs.readFileSync(
        path.join(__dirname, '..', 'core', 'automationRunner', 'scheduler', 'ticks.js'), 'utf8');
    for (const fn of ['processDueAutomations', 'reapStuckAutomations', 'processRunRetention']) {
        assert.ok(
            !new RegExp(`setTimeout\\(${fn}\\s*,`).test(ticks),
            `the boot kickoff for ${fn} calls it directly — ungated by moduleGatedTick, `
            + 'not serialised with its interval, and untracked by stop()',
        );
    }
});

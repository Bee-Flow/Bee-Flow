/**
 * webpageRuntimeManager hardening regressions (BE-P3).
 *
 * This module is GATED + INERT by default (WEBPAGE_FULL_RUNTIME_ENABLED=1 AND
 * a reachable Docker daemon are both required — see the file's own header
 * comment). These tests exercise the pieces that don't require Docker:
 *   - envInt/envFloat: malformed/out-of-range tunables clamp instead of
 *     propagating NaN into Docker's HostConfig.
 *   - hydrateProject: a path-escape attempt in an extra-file's path is refused
 *     rather than written outside the bind-mounted workdir (defense in depth
 *     behind webpageStore's own `..`-rejection).
 *   - withOrgLock: concurrent calls for the SAME org serialize (closes the
 *     count-then-create TOCTOU on the per-org container cap); different orgs
 *     don't block each other.
 *   - shouldReap / reapIdle: a container that is still cold-starting is NOT
 *     swept as an orphan (it is registered in `runtimes` only once the dev
 *     server answers, so the 60s reaper used to destroy containers — and their
 *     hydrated workdir — mid-boot), while real orphans still are.
 *
 * webpageStore is mocked ONCE, before the module-under-test is first
 * required — repeatedly patching/restoring Module._resolveFilename around
 * separate require() calls is unreliable on newer Node CJS loaders (observed
 * on Node 24: a second patch-then-require cycle silently fell back to
 * whatever was cached, not the fresh mock). A single upfront patch + a
 * mutable behavior object that individual tests configure avoids the issue
 * and matches how server/stores/knowledgeBases.authz.test.js mocks ../db.
 *
 * Run: node --test services/webpageRuntimeManager.hardening.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

// ── Mock ../stores/webpageStore BEFORE the first require of the module under
// test, so its top-level `const webpageStore = require('../stores/webpageStore')`
// captures the mock. Tests reconfigure `mockBehavior`'s fields directly rather
// than re-patching module resolution.
const mockBehavior = {
    readAllSlots: async () => ({}),
    listExtraFiles: async () => [],
    readExtraFile: async () => null,
};
// `dockerode` is intercepted the same way: the reapIdle test drives a fake
// daemon, and the manager require()s dockerode lazily inside getDocker().
const dockerState = { containers: [], removed: [] };
class FakeDocker {
    async ping() { return true; }
    async listContainers() { return dockerState.containers.filter(c => c.State !== 'removed'); }
    getContainer(id) {
        const rec = dockerState.containers.find(c => c.Id === id);
        if (!rec) { const e = new Error('no such container'); e.statusCode = 404; throw e; }
        return {
            stop: async () => { rec.State = 'exited'; },
            remove: async () => { rec.State = 'removed'; dockerState.removed.push(rec.Id); },
        };
    }
}

const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../stores/webpageStore') return 'mock-webpage-store-for-runtime-manager';
    if (request === 'dockerode') return 'mock-dockerode-for-runtime-manager';
    return originalResolveFilename.call(this, request, parent, ...rest);
};
require.cache['mock-dockerode-for-runtime-manager'] = {
    id: 'mock-dockerode-for-runtime-manager',
    exports: FakeDocker,
};
require.cache['mock-webpage-store-for-runtime-manager'] = {
    id: 'mock-webpage-store-for-runtime-manager',
    exports: {
        readAllSlots: (...args) => mockBehavior.readAllSlots(...args),
        listExtraFiles: (...args) => mockBehavior.listExtraFiles(...args),
        readExtraFile: (...args) => mockBehavior.readExtraFile(...args),
    },
};

const runtimeManager = require('./webpageRuntimeManager');

// ── envInt / envFloat ─────────────────────────────────────────────

test('_envInt falls back to default on missing/empty/malformed input', () => {
    delete process.env.__TEST_INT__;
    assert.strictEqual(runtimeManager._envInt('__TEST_INT__', 42), 42);
    process.env.__TEST_INT__ = '';
    assert.strictEqual(runtimeManager._envInt('__TEST_INT__', 42), 42);
    process.env.__TEST_INT__ = 'not-a-number';
    assert.strictEqual(runtimeManager._envInt('__TEST_INT__', 42), 42);
    delete process.env.__TEST_INT__;
});

test('_envInt clamps to [min, max]', () => {
    process.env.__TEST_INT2__ = '99999';
    assert.strictEqual(runtimeManager._envInt('__TEST_INT2__', 10, { min: 1, max: 100 }), 100);
    process.env.__TEST_INT2__ = '-5';
    assert.strictEqual(runtimeManager._envInt('__TEST_INT2__', 10, { min: 1, max: 100 }), 1);
    process.env.__TEST_INT2__ = '50';
    assert.strictEqual(runtimeManager._envInt('__TEST_INT2__', 10, { min: 1, max: 100 }), 50);
    delete process.env.__TEST_INT2__;
});

test('_envFloat clamps and rejects NaN the same way', () => {
    process.env.__TEST_FLOAT__ = 'abc';
    assert.strictEqual(runtimeManager._envFloat('__TEST_FLOAT__', 0.5, { min: 0.25, max: 8 }), 0.5);
    process.env.__TEST_FLOAT__ = '100';
    assert.strictEqual(runtimeManager._envFloat('__TEST_FLOAT__', 0.5, { min: 0.25, max: 8 }), 8);
    delete process.env.__TEST_FLOAT__;
});

// ── hydrateProject path containment ──────────────────────────────
//
// Both cases run inside ONE test — mockBehavior is shared, mutable module
// state, and node:test runs sibling top-level tests concurrently by default,
// so two separate tests mutating it would race each other.

test('hydrateProject: containment refuses escapes but writes normal files', async () => {
    const escapeWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-hydrate-test-'));
    const normalWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), 'bf-hydrate-test-'));
    try {
        mockBehavior.listExtraFiles = async () => [{ path: '../../../../../../tmp/should-not-write', isText: true }];
        mockBehavior.readExtraFile = async () => ({ meta: { isText: true }, text: 'escaped!' });
        const escapeCount = await runtimeManager.hydrateProject('wp1', 'user1', escapeWorkdir);
        assert.strictEqual(escapeCount, 0, 'the escaping path must not be counted as written');
        // The escape target must not exist — either webpageStore's own `..`
        // rejection or our containment check should have refused it.
        await assert.rejects(fs.access(path.join(escapeWorkdir, '..', '..', '..', '..', '..', '..', 'tmp', 'should-not-write')));

        mockBehavior.listExtraFiles = async () => [{ path: 'src/App.jsx', isText: true }];
        mockBehavior.readExtraFile = async () => ({ meta: { isText: true }, text: 'export default function App(){}' });
        const count = await runtimeManager.hydrateProject('wp1', 'user1', normalWorkdir);
        assert.strictEqual(count, 1);
        const written = await fs.readFile(path.join(normalWorkdir, 'src', 'App.jsx'), 'utf8');
        assert.match(written, /export default function App/);
    } finally {
        mockBehavior.listExtraFiles = async () => [];
        mockBehavior.readExtraFile = async () => null;
        await fs.rm(escapeWorkdir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(normalWorkdir, { recursive: true, force: true }).catch(() => {});
    }
});

// ── withOrgLock ───────────────────────────────────────────────────

test('_withOrgLock serializes calls for the same org', async () => {
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = (label, delayMs) => async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(`start:${label}`);
        await new Promise(r => setTimeout(r, delayMs));
        order.push(`end:${label}`);
        concurrent--;
        return label;
    };

    const results = await Promise.all([
        runtimeManager._withOrgLock('org-a', task('a1', 20)),
        runtimeManager._withOrgLock('org-a', task('a2', 5)),
    ]);

    assert.deepStrictEqual(results, ['a1', 'a2']);
    assert.strictEqual(maxConcurrent, 1, 'same-org calls must never overlap');
    assert.deepStrictEqual(order, ['start:a1', 'end:a1', 'start:a2', 'end:a2']);
});

test('_withOrgLock does not serialize calls for different orgs', async () => {
    let concurrent = 0;
    let sawOverlap = false;
    const task = (delayMs) => async () => {
        concurrent++;
        if (concurrent > 1) sawOverlap = true;
        await new Promise(r => setTimeout(r, delayMs));
        concurrent--;
    };

    await Promise.all([
        runtimeManager._withOrgLock('org-b', task(30)),
        runtimeManager._withOrgLock('org-c', task(30)),
    ]);

    assert.strictEqual(sawOverlap, true, 'different orgs should run concurrently');
});

test('_withOrgLock recovers after a rejected task (chain never gets stuck)', async () => {
    await assert.rejects(runtimeManager._withOrgLock('org-d', async () => { throw new Error('boom'); }));
    // A subsequent call for the same org must still run — the internal chain
    // tail swallows the rejection so it doesn't poison later callers.
    const result = await runtimeManager._withOrgLock('org-d', async () => 'recovered');
    assert.strictEqual(result, 'recovered');
});

// ── Reaper: cold-start grace ──────────────────────────────────────────────
//
// Defaults apply here (the module reads its tunables at import and this file
// sets no WEBPAGE_RUNNER_* env): idle TTL 15min, max age 4h, ready timeout 90s
// ⇒ startup grace 120s.

test('_shouldReap spares a cold-starting container but still sweeps real orphans', () => {
    const now = Date.now();
    const grace = runtimeManager._STARTUP_GRACE_MS;
    assert.ok(grace > 60_000, 'the grace must outlast one 60s reaper tick');

    // Booting normally: created seconds ago, running, not yet in `runtimes`
    // (createRuntime registers it only after waitForReady resolves).
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'running', born: now - 5_000, entry: null, now }),
        false, 'a container inside its boot window must not be treated as an orphan');
    // Still inside the window one tick later.
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'running', born: now - 61_000, entry: null, now }),
        false, 'the second reaper tick of a slow boot must not reap it either');
    // Docker has created it but start() hasn't returned yet.
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'created', born: now - 1_000, entry: null, now }),
        false, 'the create→start gap must not be reaped');

    // Boot already failed — nothing to protect.
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'exited', born: now - 5_000, entry: null, now }),
        true, 'a container that died during boot is garbage, grace or not');
    // Past the window with nobody owning it: a genuine orphan from a crashed worker.
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'running', born: now - (grace + 1_000), entry: null, now }),
        true, 'orphans are still swept, one grace period later');
    // Unlabelled container: age unknown, orphan handling unchanged.
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'running', born: 0, entry: null, now }),
        true, 'a container without a bf.bornAt label gets no grace');
    // A stuck 'created' container past the window.
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'created', born: now - (grace + 1_000), entry: null, now }),
        true);

    // Registered runtimes keep the original idle / max-age behaviour.
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'running', born: now - 60_000, entry: { lastAccess: now - 1_000 }, now }),
        false, 'a recently used runtime is kept');
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'running', born: now - 60 * 60_000, entry: { lastAccess: now - 16 * 60_000 }, now }),
        true, 'idle past IDLE_TTL_MS is reaped');
    assert.strictEqual(
        runtimeManager._shouldReap({ state: 'running', born: now - 5 * 60 * 60_000, entry: { lastAccess: now }, now }),
        true, 'older than MAX_AGE_MS is reaped even while in use');
});

test('reapIdle leaves a cold-starting container alone and removes the old orphan', async () => {
    const now = Date.now();
    dockerState.containers = [
        { Id: 'c-booting', State: 'running', Labels: { 'bf.kind': 'webpage-runtime', 'bf.webpageId': 'wp-booting', 'bf.bornAt': String(now - 3_000) } },
        { Id: 'c-orphan', State: 'running', Labels: { 'bf.kind': 'webpage-runtime', 'bf.webpageId': 'wp-orphan', 'bf.bornAt': String(now - 6 * 60 * 60_000) } },
    ];
    dockerState.removed = [];

    // dockerAvailable(): gate on + a "reachable" daemon socket. The result is
    // cached inside the module, so the fake daemon serves every later call too.
    const previousGate = process.env.WEBPAGE_FULL_RUNTIME_ENABLED;
    process.env.WEBPAGE_FULL_RUNTIME_ENABLED = '1';
    const fsSync = require('node:fs');
    const realExistsSync = fsSync.existsSync;
    fsSync.existsSync = (p) => (p === '/var/run/docker.sock' ? true : realExistsSync(p));
    try {
        const { reaped } = await runtimeManager.reapIdle();
        assert.strictEqual(reaped, 1);
        assert.deepStrictEqual(dockerState.removed, ['c-orphan'],
            'only the aged orphan may be removed — the booting container is mid-createRuntime');
    } finally {
        fsSync.existsSync = realExistsSync;
        if (previousGate === undefined) delete process.env.WEBPAGE_FULL_RUNTIME_ENABLED;
        else process.env.WEBPAGE_FULL_RUNTIME_ENABLED = previousGate;
    }
});

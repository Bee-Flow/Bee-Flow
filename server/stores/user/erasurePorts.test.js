// @typecheck strict
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { registerErasurePorts, erasurePort, erasurePortNames, resetErasurePortsForTests } = require('./erasurePorts');

beforeEach(() => resetErasurePortsForTests());

test('erasurePort throws when unregistered (fail closed)', () => {
    assert.throws(() => erasurePort('notebooks'), /Erasure port 'notebooks' is not registered/);
    assert.throws(() => erasurePort('projects'), /Erasure port 'projects' is not registered/);
});

test('registered ports are returned; registering one keeps the other unregistered', () => {
    const notebooks = { deleteAllForUser: async () => ({ notebooks: 2 }) };
    registerErasurePorts({ notebooks });
    assert.strictEqual(erasurePort('notebooks'), notebooks);
    assert.throws(() => erasurePort('projects'), /not registered/);
});

test('erasurePortNames lists what is registered, in registration order', () => {
    assert.deepStrictEqual(erasurePortNames(), []);
    registerErasurePorts({ projects: { makeTeardown: () => null } });
    registerErasurePorts({ notebooks: { deleteAllForUser: async () => ({}) } });
    assert.deepStrictEqual(erasurePortNames(), ['projects', 'notebooks']);
});

test('projects module absent and its code not here: an owned project refuses the erasure, an account without one is erased', () => {
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const code = [
        `const { eraseOwnedProjects } = require(${JSON.stringify(require.resolve('./projectErasure'))});`,
        `const { projectTeardown } = require(${JSON.stringify(require.resolve('./erasurePorts'))});`,
        'const quiet = { countSharedThreads: async () => 0, handOver: async () => null };',
        '(async () => {',
        '    const none = await eraseOwnedProjects("u1", { ...quiet, listOwned: async () => [] });',
        '    const one = await eraseOwnedProjects("u1", { ...quiet, listOwned: async () => ["p1"] });',
        '    const refusal = await projectTeardown().teardownRefusal("p1").catch((e) => e.code);',
        '    process.stdout.write(JSON.stringify({ none, one, refusal }));',
        '})();',
    ].join('\n');
    const env = { ...process.env, BEEFLOW_HIDE_MODULES: 'projects', NODE_ENV: 'test' };
    const r = spawnSync(process.execPath, ['--require', './moduleRoots.cjs', '-e', code],
        { cwd: path.resolve(__dirname, '..', '..'), env, encoding: 'utf8', timeout: 60_000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(out.none, { deleted: 0, kept: 0, failed: 0, handedOver: 0 });
    assert.deepStrictEqual(out.one, { deleted: 0, kept: 0, failed: 1, handedOver: 0 });
    assert.strictEqual(out.refusal, 'MODULE_DATA_PRESENT');
});

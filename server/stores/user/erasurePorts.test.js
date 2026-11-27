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

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startRedis, REDIS_CMD } = require('./guardRedis');

test('guard Redis runs without persistence: no RDB, no AOF, no volume', async () => {
    /** @type {any} */
    let created = null;
    let started = false;
    const docker = /** @type {any} */ ({
        createContainer: async (/** @type {any} */ opts) => {
            created = opts;
            return { start: async () => { started = true; } };
        },
    });
    await startRedis(docker, { container: 'beeflow-guard-redis', network: 'beeflow-guard-net' });
    assert.ok(started);
    const cmd = created.Cmd;
    assert.deepStrictEqual(cmd, [...REDIS_CMD]);
    assert.strictEqual(cmd[cmd.indexOf('--save') + 1], '');
    assert.strictEqual(cmd[cmd.indexOf('--appendonly') + 1], 'no');
    assert.strictEqual(created.HostConfig.Binds, undefined);
    assert.strictEqual(created.HostConfig.Mounts, undefined);
    assert.strictEqual(created.HostConfig.NetworkMode, 'beeflow-guard-net');
});

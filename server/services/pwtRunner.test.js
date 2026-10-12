/**
 * pwtRunner's Docker probe and runner-image tag order (services/pwtRunner.js).
 *
 * A `false` from dockerAvailable() used to be cached for the life of the
 * process: a socket mounted after boot was never seen without a restart. It
 * is trusted for DOCKER_UNAVAILABLE_RETRY_MS now, and the reason (no socket
 * vs. no permission) is logged once per change instead of never.
 *
 * Run: cd server && node --test services/pwtRunner.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const runnerModule = require('./pwtRunner');

// The fake daemon, the socket "file" and what the probe logged.
const daemon = { pings: 0, pingError: null };
const warnings = [];
// An error code to throw from the socket access check, or null when it is usable.
let socketError = null;

const DEPS = {
    createDocker: () => ({
        async ping() {
            daemon.pings += 1;
            if (daemon.pingError) throw daemon.pingError;
            return 'OK';
        },
    }),
    accessSync: (p) => {
        if (socketError) throw Object.assign(new Error(`${socketError}: ${p}`), { code: socketError });
    },
    log: { info() {}, debug() {}, error() {}, warn: (m) => warnings.push(String(m)) },
};

function freshRunner() {
    runnerModule.__setDepsForTests(DEPS);
    return runnerModule;
}

test.after(() => runnerModule.__setDepsForTests());

test.beforeEach(() => {
    daemon.pings = 0;
    daemon.pingError = null;
    warnings.length = 0;
    socketError = null;
});

test('a missing socket is not trusted forever: once the socket appears, the next probe after the TTL sees it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const runner = freshRunner();

    socketError = 'ENOENT';
    assert.strictEqual(await runner.dockerAvailable(), false);

    socketError = null; // the operator mounts the socket
    assert.strictEqual(await runner.dockerAvailable(), false, 'inside the TTL the negative answer is reused');
    assert.strictEqual(daemon.pings, 0, 'and the daemon is not asked');

    t.mock.timers.tick(runner.DOCKER_UNAVAILABLE_RETRY_MS);
    assert.strictEqual(await runner.dockerAvailable(), true, 'after the TTL the probe runs again');
    assert.strictEqual(daemon.pings, 1);

    socketError = 'ENOENT';
    assert.strictEqual(await runner.dockerAvailable(), true, 'a success stays cached for the process');
});

test('no socket and no permission are logged apart, each once per change', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const runner = freshRunner();

    socketError = 'ENOENT';
    await runner.dockerAvailable();
    t.mock.timers.tick(runner.DOCKER_UNAVAILABLE_RETRY_MS);
    await runner.dockerAvailable();
    assert.strictEqual(warnings.length, 1, 'the same reason is not repeated on every probe');
    assert.match(warnings[0], /not mounted/);
    assert.match(warnings[0], /ENOENT/);

    socketError = 'EACCES';
    t.mock.timers.tick(runner.DOCKER_UNAVAILABLE_RETRY_MS);
    await runner.dockerAvailable();
    assert.strictEqual(warnings.length, 2);
    assert.match(warnings[1], /EACCES/);
    assert.match(warnings[1], /group_add/);
});

test('a socket that is there but a daemon that does not answer is its own reason', async () => {
    const runner = freshRunner();
    daemon.pingError = Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), { code: 'ECONNREFUSED' });
    assert.strictEqual(await runner.dockerAvailable(), false);
    assert.match(warnings[0], /did not answer/);
    assert.match(warnings[0], /ECONNREFUSED/);
});

test('a production server tries the released runner tag before the main-branch build', () => {
    const { registryTagChain } = freshRunner();
    assert.deepStrictEqual(registryTagChain({ NODE_ENV: 'production' }), ['latest', 'dev']);
    assert.deepStrictEqual(registryTagChain({ NODE_ENV: 'development' }), ['dev', 'latest']);
    assert.deepStrictEqual(registryTagChain({}), ['dev', 'latest']);
    assert.deepStrictEqual(registryTagChain({ NODE_ENV: 'production', PLAYWRIGHT_RUNNER_IMAGE_TAG: 'v1.2.3' }), ['v1.2.3'],
        'an explicit tag is the only one tried');
});

// @typecheck strict
/**
 * boot/lifecycle.js: what the process does with its HTTP server and its
 * readiness state at start and at shutdown. The order of the start-up and of
 * the drain itself is pinned in boot/bootChain.characterisation.test.js.
 *
 * Run: cd server && node --test boot/lifecycle.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const lifecycle = require('./lifecycle');
const state = require('../utils/runtimeState.mts');

const quietLog = /** @type {typeof import('../telemetry/log')} */ (/** @type {unknown} */ ({ info() {}, warn() {}, error() {}, debug() {}, log() {} }));

/** @returns {{ exits: number[], proc: NodeJS.Process }} */
function fakeProc() {
    /** @type {number[]} */
    const exits = [];
    const proc = /** @type {NodeJS.Process} */ (/** @type {unknown} */ ({ on() {}, exit: (/** @type {number} */ code) => { exits.push(code); } }));
    return { exits, proc };
}

/** Start a server on a double that never opens a socket; `initDB` decides when the listener comes up. */
function start(initDB = async () => {}) {
    const server = {
        keepAliveTimeout: 0,
        headersTimeout: 0,
        listen: (/** @type {number} */ _port, /** @type {string} */ _host, /** @type {() => void} */ cb) => cb(),
    };
    const app = /** @type {import('express').Express} */ (/** @type {unknown} */ ({ use() {} }));
    const createServer = /** @type {typeof import('node:http').createServer} */ (/** @type {unknown} */ (() => server));
    const { started } = lifecycle.startServer({
        app, port: 0, terminalErrorHandler: () => {}, runStartupChecks: () => {}, runStartupTasks: () => {},
        log: quietLog, proc: fakeProc().proc,
        deps: {
            createServer,
            userStore: { initDB },
            authConfigStore: { migrate: async () => {} },
            loader: { afterListen() {} },
        },
    });
    return { server, started };
}

/**
 * The shutdown with every collaborator replaced; `order` records the calls.
 * @param {{ closeThrows?: boolean, server?: import('node:http').Server, drain?: Promise<unknown> }} [opts]
 *   `server`: a real one in place of the recording double; `drain`: what the modules' drain waits for
 */
function shutdownWith({ closeThrows = false, server: realServer, drain } = {}) {
    /** @type {string[]} */
    const order = [];
    /** @type {string[]} */
    const readinessDuringDrain = [];
    const server = realServer || /** @type {import('node:http').Server} */ (/** @type {unknown} */ ({
        close: () => { order.push('server.close'); if (closeThrows) throw new Error('not running'); },
        closeIdleConnections: () => { order.push('server.closeIdleConnections'); },
        closeAllConnections: () => { order.push('server.closeAllConnections'); },
    }));
    const { exits, proc } = fakeProc();
    const shutdown = lifecycle.installGracefulShutdown({
        server, log: quietLog, proc,
        otel: { shutdown: async () => { order.push('otel.shutdown'); } },
        disconnectRedis: async () => { order.push('disconnectRedis'); },
        deps: {
            // The modules' drains and closes (firstParty/<id>.jobs.js) go through the loader.
            loader: {
                drain: async () => {
                    order.push('drain');
                    readinessDuringDrain.push(String(state.readiness().reason));
                    await drain;
                },
                close: async () => {},
            },
            usageOpenObservePush: { stop() {} },
            opsMetricsPush: { stop() {} },
            chatSignals: { flush: async () => {} },
            configStore: { _stopInvalidationListener() {} },
        },
    });
    return { order, exits, shutdown, readinessDuringDrain };
}

/**
 * One GET on a connection of its own. A connection that fails gives status 0 and the error code as the body.
 * @param {number} port
 * @param {string} path
 * @returns {Promise<{ status: number, body: string }>}
 */
function get(port, path) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode || 0, body }));
        });
        req.on('error', (/** @type {NodeJS.ErrnoException} */ err) => resolve({ status: 0, body: String(err.code) }));
    });
}

beforeEach(() => {
    state._resetForTests();
    delete process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
    delete process.env.HTTP_HEADERS_TIMEOUT_MS;
});

test('startServer: keep-alive outlives a 60 s proxy, and the headers time-out sits above it', async () => {
    const { server, started } = start();
    await started;
    assert.strictEqual(server.keepAliveTimeout, 65_000);
    assert.strictEqual(server.headersTimeout, 66_000);
});

test('startServer: the two time-outs follow the environment, headers never at or below keep-alive', async () => {
    process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS = '120000';
    const raised = start();
    await raised.started;
    assert.strictEqual(raised.server.keepAliveTimeout, 120_000);
    assert.strictEqual(raised.server.headersTimeout, 121_000, 'the default of 66 s would be below the keep-alive');

    process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS = '10000';
    process.env.HTTP_HEADERS_TIMEOUT_MS = '30000';
    const lowered = start();
    await lowered.started;
    assert.strictEqual(lowered.server.keepAliveTimeout, 10_000);
    assert.strictEqual(lowered.server.headersTimeout, 30_000);
});

test('startServer: the boot work begins when the listener comes up, not before', async () => {
    /** @type {() => void} */
    let finishInit = () => {};
    const { started } = start(() => new Promise((resolve) => { finishInit = () => resolve(undefined); }));
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'starting' }, 'the auth schema is still migrating');
    finishInit();
    await started;
    assert.deepStrictEqual(state.readiness(), { ready: true }, 'listening, and these startup doubles register no step');
});

test('graceful shutdown: stop accepting first, close idle connections after the drain, the rest right before exit', async () => {
    state.beginBoot();
    const f = shutdownWith();
    await f.shutdown('SIGTERM');
    assert.deepStrictEqual(f.order, ['server.close', 'drain', 'server.closeIdleConnections', 'disconnectRedis',
        'otel.shutdown', 'server.closeAllConnections']);
    assert.deepStrictEqual(f.exits, [0]);
    assert.deepStrictEqual(f.readinessDuringDrain, ['shutting_down'], 'not ready from the first moment of the shutdown');
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'shutting_down' });
});

// The meeting-notes runs of this process are failed by that module's drain: firstParty/meetingNotes.jobs.test.js.

test('graceful shutdown: a server that cannot be closed does not stop the shutdown', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const f = shutdownWith({ closeThrows: true });
    await f.shutdown('SIGINT');
    assert.deepStrictEqual(f.order.slice(0, 2), ['server.close', 'drain']);
    assert.strictEqual(f.order.at(-1), 'server.closeAllConnections');
    assert.deepStrictEqual(f.exits, [0]);
});

test('graceful shutdown on a real server: the request in flight ends, a new connection is refused, an open stream does not hold the exit', async () => {
    /** @type {() => void} */
    let finishSlow = () => {};
    /** @type {() => void} */
    let slowArrived = () => {};
    const arrived = new Promise((resolve) => { slowArrived = () => resolve(undefined); });
    const server = http.createServer((req, res) => {
        if (req.url === '/slow') { finishSlow = () => res.end('finished'); slowArrived(); return; }
        if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: open\n\n'); return; }
        res.end('ok');
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

    // A streaming answer that never ends (a chat), and a request that is still being answered.
    /** @type {() => void} */
    let streamOpened = () => {};
    const opened = new Promise((resolve) => { streamOpened = () => resolve(undefined); });
    const streamEnded = new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/stream', agent: false }, (res) => {
            res.once('data', streamOpened);
            res.on('error', () => {});   // the server cuts it off mid-stream
            res.on('close', () => resolve(undefined));
        }).on('error', () => resolve(undefined));
    });
    const slow = get(port, '/slow');
    await Promise.all([arrived, opened]);

    /** @type {() => void} */
    let finishDrain = () => {};
    const f = shutdownWith({ server, drain: new Promise((resolve) => { finishDrain = () => resolve(undefined); }) });
    const done = f.shutdown('SIGTERM');

    assert.deepStrictEqual(await get(port, '/'), { status: 0, body: 'ECONNREFUSED' }, 'the listener is closed from the first moment');
    finishSlow();
    assert.deepStrictEqual(await slow, { status: 200, body: 'finished' }, 'the request in flight keeps its connection');
    assert.deepStrictEqual(f.exits, [], 'still draining');

    finishDrain();
    await done;
    assert.deepStrictEqual(f.exits, [0], 'the stream that is still open did not hold the shutdown');
    await streamEnded;   // closed by the shutdown, not left to the exit
});

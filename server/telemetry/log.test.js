const test = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');

const log = require('./log');

function captureStream() {
    const lines = [];
    const stream = new Writable({
        write(chunk, _enc, cb) { lines.push(...String(chunk).split('\n').filter(Boolean)); cb(); },
    });
    return { stream, lines: () => lines.map((l) => JSON.parse(l)) };
}

test('json mode follows LOG_FORMAT, then NODE_ENV', () => {
    assert.strictEqual(log.isJsonMode({ LOG_FORMAT: 'json' }), true);
    assert.strictEqual(log.isJsonMode({ LOG_FORMAT: 'console', NODE_ENV: 'production' }), false);
    assert.strictEqual(log.isJsonMode({ NODE_ENV: 'production' }), true);
    assert.strictEqual(log.isJsonMode({ NODE_ENV: 'test' }), false);
    assert.strictEqual(log.isJsonMode({}), false);
});

test('console mode calls the console method that is installed at call time', () => {
    const logger = log.createLogger({ json: false });
    const calls = [];
    const original = console.warn;
    console.warn = (...args) => calls.push(args);
    try {
        logger.warn('[Tag] careful', 42);
    } finally {
        console.warn = original;
    }
    assert.deepStrictEqual(calls, [['[Tag] careful', 42]]);
});

test('console mode maps info and log to console.log and keeps every argument', () => {
    const logger = log.createLogger({ json: false });
    const calls = [];
    const original = console.log;
    console.log = (...args) => calls.push(args);
    try {
        logger.info('a', { b: 1 });
        logger.log('c');
    } finally {
        console.log = original;
    }
    assert.deepStrictEqual(calls, [['a', { b: 1 }], ['c']]);
});

test('json mode writes one object per line with level, msg and the request id', async () => {
    const { stream, lines } = captureStream();
    const logger = log.createLogger({ json: true, stream, level: 'debug' });
    await new Promise((resolve) => {
        log.runWithRequestId('req-42', () => {
            logger.info('[KB] indexed %d chunks', 7, { kb: 'x' });
            resolve();
        });
    });
    logger.warn('outside');
    const [first, second] = lines();
    assert.strictEqual(first.level, 'info');
    assert.strictEqual(first.msg, "[KB] indexed 7 chunks { kb: 'x' }");
    assert.strictEqual(first.reqId, 'req-42');
    assert.match(first.time, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(second.level, 'warn');
    assert.strictEqual(second.msg, 'outside');
    assert.strictEqual('reqId' in second, false);
});

test('json mode carries the first Error structurally and its message in msg', () => {
    const { stream, lines } = captureStream();
    const logger = log.createLogger({ json: true, stream });
    const boom = new Error('disk full');
    logger.error('[Upload] failed:', boom);
    const [entry] = lines();
    assert.strictEqual(entry.msg, '[Upload] failed: disk full');
    assert.strictEqual(entry.err.message, 'disk full');
    assert.strictEqual(entry.err.type, 'Error');
    assert.match(entry.err.stack, /disk full/);
});

test('json mode drops entries below the configured level', () => {
    const { stream, lines } = captureStream();
    const logger = log.createLogger({ json: true, stream, level: 'warn' });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');
    assert.deepStrictEqual(lines().map((l) => l.level), ['warn', 'error']);
});

test('the default export is console-shaped', () => {
    for (const method of ['debug', 'info', 'warn', 'error', 'log']) {
        assert.strictEqual(typeof log[method], 'function', method);
    }
});

// @typecheck
const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const log = require('../telemetry/log');
const job = require('./memoryTelemetry');

const lines = [];
const origInfo = log.info;
log.info = (m) => { lines.push(String(m)); };
afterEach(() => { job.stop(); lines.length = 0; delete process.env.MEMORY_TELEMETRY_INTERVAL_MS; });
test.after(() => { log.info = origInfo; });

test('snapshot reports the five fields in MB', () => {
    const m = job.snapshot({ rss: 200 * 1048576, heapUsed: 50 * 1048576, heapTotal: 80 * 1048576, external: 3 * 1048576, arrayBuffers: 1 * 1048576 });
    assert.deepStrictEqual(m, { rss: 200, heapUsed: 50, heapTotal: 80, external: 3, arrayBuffers: 1 });
});

test('logOnce logs all fields', () => {
    job.logOnce();
    assert.match(lines[0], /rss=\d+MB heapUsed=\d+MB heapTotal=\d+MB external=\d+MB arrayBuffers=\d+MB/);
});

test('default interval is 5 minutes; 0 means off', () => {
    assert.strictEqual(job.intervalMs(), 300000);
    process.env.MEMORY_TELEMETRY_INTERVAL_MS = '0';
    assert.strictEqual(job.intervalMs(), 0);
    job.start();
    assert.strictEqual(job.intervalMs(), 0);
});

test('start schedules an unref\'d timer that logs on each tick', async () => {
    process.env.MEMORY_TELEMETRY_INTERVAL_MS = '10';
    job.start();
    await new Promise((r) => setTimeout(r, 50));
    job.stop();
    assert.ok(lines.length >= 1);
});

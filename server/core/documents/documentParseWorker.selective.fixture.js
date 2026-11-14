// @typecheck strict
'use strict';
/**
 * Test fixture for documentParsePool.test.js: a parse worker that never answers a job
 * named "hang" and answers every other job at once with its file name.
 */

const { parentPort } = require('worker_threads');

if (!parentPort) throw new Error('documentParseWorker.selective.fixture must run as a worker thread');
const port = parentPort;
port.on('message', (/** @type {{ filename: string }} */ job) => {
    if (job.filename === 'hang') return; // the deadline under test ends this worker
    port.postMessage({ ok: true, text: `parsed ${job.filename}` });
});

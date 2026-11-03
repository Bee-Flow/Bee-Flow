'use strict';
/**
 * Test fixture for documentParser.test.js: a parse worker that takes every job and never
 * answers, so the pool's deadline is the only way the parse can end.
 */

const { parentPort } = require('worker_threads');

if (!parentPort) throw new Error('documentParseWorker.hang.fixture must run as a worker thread');
parentPort.on('message', () => { /* never answers: the deadline under test ends this worker */ });

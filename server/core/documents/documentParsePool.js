// @typecheck strict
'use strict';
/**
 * Runs the document parsers (mammoth, SheetJS, pdf.js, the pptx reader) in
 * worker threads with a deadline and a memory ceiling.
 *
 * An upload is untrusted and the parsers are pure JavaScript on the thread
 * that runs them: a crafted file can keep one busy for minutes or make it
 * allocate until the process dies, and on the main thread that is every
 * tenant's request. So a parse goes to a worker (./documentParseWorker.js)
 * that holds the parsers loaded; a parse that does not answer within the
 * deadline ends its worker (terminate), one that passes the memory ceiling
 * is ended by V8 (resourceLimits), and either comes back as a parse failure
 * for that one file. A few workers run side by side; each exits after a
 * while idle and keeps nothing alive.
 *
 *   DOCUMENT_PARSE_TIMEOUT_MS   deadline per document (default 60000; 0 runs
 *                               the parsers in-process without one)
 *   DOCUMENT_PARSE_MEMORY_MB    old-space ceiling per worker (default 1024;
 *                               0 = V8's own default)
 *   DOCUMENT_PARSE_WORKERS      workers side by side (default 2)
 */

const path = require('path');
const { Worker } = require('worker_threads');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_WORKERS = 2;
const IDLE_EXIT_MS = 60_000;

/** @param {string} name @param {number} fallback */
function envNumber(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

/** The deadline in ms; 0 = in-process. */
function parseTimeoutMs() { return envNumber('DOCUMENT_PARSE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS); }

class DocumentParseError extends Error {
    /** @param {string} message @param {'timeout' | 'memory' | 'worker'} kind */
    constructor(message, kind) { super(message); this.name = 'DocumentParseError'; this.kind = kind; }
}

/**
 * @typedef {{ worker: Worker, busy: boolean, idleTimer: NodeJS.Timeout | null }} Slot
 * @typedef {{ job: { buffer: Buffer, mimeType: string, filename: string, options: object }, resolve: (v: string) => void, reject: (e: Error) => void }} Queued
 */

/** @type {Slot[]} */
const slots = [];
/** @type {Queued[]} */
const queue = [];

// The worker script; a test swaps in one that never answers (see _useWorkerScript).
let workerScript = path.join(__dirname, 'documentParseWorker.js');

function spawnSlot() {
    const memoryMb = envNumber('DOCUMENT_PARSE_MEMORY_MB', DEFAULT_MEMORY_MB);
    const worker = new Worker(workerScript, {
        ...(memoryMb > 0 ? { resourceLimits: { maxOldGenerationSizeMb: memoryMb } } : {}),
    });
    /** @type {Slot} */
    const slot = { worker, busy: false, idleTimer: null };
    worker.unref();
    worker.on('exit', () => {
        const i = slots.indexOf(slot);
        if (i >= 0) slots.splice(i, 1);
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
    });
    slots.push(slot);
    return slot;
}

/** @param {Slot} slot */
function retireLater(slot) {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => { slot.worker.terminate().catch((e) => bestEffort('documentParsePool:terminate', e)); }, IDLE_EXIT_MS);
    slot.idleTimer.unref();
}

/**
 * @param {Slot} slot
 * @param {Queued} item
 * @param {number} timeoutMs
 */
function runOn(slot, item, timeoutMs) {
    slot.busy = true;
    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    slot.worker.ref();
    const { job, resolve, reject } = item;
    let done = false;
    /** @param {() => void} settle */
    const finish = (settle) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        slot.worker.off('message', onMessage);
        slot.worker.off('error', onError);
        slot.worker.off('exit', onExit);
        settle();
        slot.busy = false;
        slot.worker.unref();
        retireLater(slot);
        pump();
    };
    /** @param {{ ok: boolean, text?: string, error?: string }} msg */
    const onMessage = (msg) => finish(() => (msg.ok ? resolve(String(msg.text)) : reject(new Error(msg.error || 'parse failed'))));
    /** @param {Error & { code?: string }} err */
    const onError = (err) => {
        const memory = err?.code === 'ERR_WORKER_OUT_OF_MEMORY';
        finish(() => reject(new DocumentParseError(memory ? 'the document needs more memory than a parse may use' : `the parser stopped: ${err.message}`, memory ? 'memory' : 'worker')));
    };
    const onExit = () => finish(() => reject(new DocumentParseError('the parser stopped before answering', 'worker')));
    const timer = setTimeout(() => {
        log.warn(`[DocumentParser] parsing ${log.nameForLog(job.filename)} exceeded ${timeoutMs} ms; stopping its worker`);
        slot.worker.terminate().catch((e) => bestEffort('documentParsePool:terminate', e));
        finish(() => reject(new DocumentParseError(`parsing took longer than ${Math.round(timeoutMs / 1000)} s`, 'timeout')));
    }, timeoutMs);
    slot.worker.on('message', onMessage);
    slot.worker.on('error', onError);
    slot.worker.on('exit', onExit);
    slot.worker.postMessage(job);
}

function pump() {
    while (queue.length) {
        const free = slots.find((s) => !s.busy);
        const slot = free || (slots.length < envNumber('DOCUMENT_PARSE_WORKERS', DEFAULT_WORKERS) ? spawnSlot() : null);
        if (!slot) return;
        const item = /** @type {Queued} */ (queue.shift());
        runOn(slot, item, parseTimeoutMs());
    }
}

/**
 * Parse in a worker, under the deadline and the memory ceiling.
 * @param {{ buffer: Buffer, mimeType: string, filename: string, options: object }} job
 * @returns {Promise<string>}
 */
function parseInWorker(job) {
    return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject });
        pump();
    });
}

/** End every worker (tests, shutdown). */
async function closeDocumentParsePool() {
    const all = slots.splice(0);
    await Promise.all(all.map((s) => s.worker.terminate().catch((e) => bestEffort('documentParsePool:terminate', e))));
}

/**
 * Tests only: run the next workers from another script (null = the real one), after ending the
 * current ones. A deadline test needs a parse that is slow for certain; racing a real parser
 * against a 1 ms deadline lost whenever a warm worker answered first.
 * @param {string | null} script
 */
async function _useWorkerScript(script) {
    await closeDocumentParsePool();
    workerScript = script || path.join(__dirname, 'documentParseWorker.js');
}

module.exports = { parseInWorker, parseTimeoutMs, closeDocumentParsePool, DocumentParseError, DEFAULT_TIMEOUT_MS, DEFAULT_MEMORY_MB, _useWorkerScript };

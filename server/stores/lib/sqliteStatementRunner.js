// @typecheck strict
'use strict';

/**
 * Runs the statements of one SQLite-blob engine under a deadline.
 *
 * better-sqlite3 is synchronous and has no interrupt: a statement an author
 * wrote (a recursive CTE without an end, a cross join of two big tables) runs
 * on the thread it was started on until it finishes, and on the main thread
 * that is every tenant's request. So a runner forks a statement process per
 * owner of the page database (./sqliteStatementChild.js), lazily, and sends
 * each statement to its owner's process with its file path. A stop at the
 * deadline therefore only touches the statements of that owner. The number of
 * processes is capped by SQLITE_STATEMENT_MAX_PROCESSES (default 8, 0 =
 * unlimited): at the cap an idle process is retired for the new owner, and
 * when none is idle the owner shares the least busy one. A process that has
 * had nothing to do for SQLITE_STATEMENT_IDLE_MS (default 60000, 0 = never)
 * is retired. A statement that does not answer within the deadline
 * ends the process (SIGKILL): the operating system releases its file locks,
 * every statement in flight fails with a timeout error, and the next
 * statement starts a fresh process once the old one is gone. A read-only
 * statement (query, schema) that was waiting behind the stopped one, from any
 * page database, is sent once more to the fresh process with a fresh
 * deadline: reads are safe to repeat, and one slow statement should not fail
 * another page's read. A write in flight fails with the timeout error, since
 * it may already have committed. The main handle
 * of each affected file then does one read, which makes SQLite roll back the
 * hot journal the killed write left, so the flusher never uploads a
 * half-written file.
 *
 * A process, not a worker thread: a thread ended mid-statement cannot be
 * relied on to close its connection, and a connection that is never closed
 * keeps its lock on the file for the life of the server.
 *
 * The deadline is SQLITE_STATEMENT_TIMEOUT_MS (default 5000). 0 switches the
 * deadline off, and with it the statement process: statements then run in
 * this process as they always did.
 */

const path = require('path');
const { fork } = require('child_process');
const log = require('../../telemetry/log');
const { STATEMENT_OPS } = require('./sqliteBlobStatements');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PROCESSES = 8;
const DEFAULT_IDLE_MS = 60_000;

/** Operations that only read: repeating one after a stop changes nothing. */
const RETRYABLE_OPS = new Set(['query', 'schema']);

/** The configured deadline in ms; 0 = off. */
function statementTimeoutMs() {
    const raw = process.env.SQLITE_STATEMENT_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_TIMEOUT_MS;
}

/**
 * A non-negative integer from the environment, or `fallback`.
 * @param {string} name
 * @param {number} fallback
 */
function envCount(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

class StatementTimeoutError extends Error {
    /** @param {string} message */
    constructor(message) { super(message); this.name = 'StatementTimeoutError'; this.code = 'statement_timeout'; }
}

/**
 * A Buffer that crossed the process boundary arrives as a plain Uint8Array;
 * callers (and JSON responses) expect Buffers for blob cells.
 * @param {unknown} v
 * @returns {unknown}
 */
function reviveBlobs(v) {
    if (v instanceof Uint8Array) return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (Array.isArray(v)) return v.map(reviveBlobs);
    if (v && typeof v === 'object') {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = reviveBlobs(x);
        return out;
    }
    return v;
}

/**
 * @typedef {import('./sqliteBlobHandles').BlobHandle & { db: import('./sqliteBlobStatements').SqliteDb }} RunnerHandle
 * @typedef {keyof typeof STATEMENT_OPS} StatementOp
 * @typedef {import('child_process').ChildProcess} ChildProcess
 * @typedef {{ resolve: (v: unknown) => void, reject: (e: Error) => void, entry: RunnerHandle, timer: NodeJS.Timeout, proc: ChildProcess, op: StatementOp, args: unknown[], retried: boolean }} Pending
 * @typedef {{ id: number, ok: boolean, result?: unknown, error?: { message: string, code?: string } }} ChildReply
 */

/** One statement process and the statements sent to it. */
class StatementLane {
    /** @param {{ timeoutMs: number, entityLabel: string, logPrefix: string, idleMs?: number, onIdle?: () => void }} opts */
    constructor({ timeoutMs, entityLabel, logPrefix, idleMs = 0, onIdle }) {
        this.idleMs = idleMs;
        this.onIdle = onIdle;
        /** @type {NodeJS.Timeout | null} */
        this.idleTimer = null;
        this.timeoutMs = timeoutMs;
        this.entityLabel = entityLabel;
        this.logPrefix = logPrefix;
        /** @type {ChildProcess | null} */
        this.child = null;
        /** @type {Map<number, Pending>} */
        this.inflight = new Map();
        this.seq = 0;
        /** Files a killed statement touched, read once its process is gone. @type {Pending[]} */
        this.pendingRecovery = [];
        /** Resolves when a killed process has exited; the next statement waits for it. @type {Promise<void> | null} */
        this.draining = null;
    }

    // The process keeps nothing alive while idle: a test file or a server
    // shutting down must be able to exit with it waiting.
    hold() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        if (this.child) { this.child.ref(); this.child.channel?.ref(); }
    }

    release() {
        if (this.inflight.size !== 0) return;
        if (this.child) { this.child.unref(); this.child.channel?.unref(); }
        if (this.idleMs > 0 && this.onIdle && !this.idleTimer) {
            const onIdle = this.onIdle;
            this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.isIdle()) onIdle(); }, this.idleMs);
            this.idleTimer.unref();
        }
    }

    /** Nothing in flight and no stopped process still exiting. */
    isIdle() { return this.inflight.size === 0 && !this.draining; }

    /** End an idle process cleanly: it closes its connections on disconnect. */
    retire() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const proc = this.child;
        this.child = null;
        if (proc && proc.connected) proc.disconnect();
    }

    /**
     * Fail every statement sent to `proc` (one already sent to its successor
     * is not touched). A statement `spare` accepts is taken out of flight
     * without failing and handed to `spared` instead.
     * @param {ChildProcess} proc
     * @param {Error} err
     * @param {(p: Pending) => boolean} [spare]
     * @param {Pending[]} [spared]
     */
    failFor(proc, err, spare, spared) {
        /** @type {Pending[]} */
        const failed = [];
        for (const [id, p] of this.inflight) {
            if (p.proc !== proc) continue;
            this.inflight.delete(id);
            clearTimeout(p.timer);
            if (spare && spared && spare(p)) { spared.push(p); continue; }
            p.reject(err);
            failed.push(p);
        }
        return failed;
    }

    /**
     * One read on the main handle of every file a killed statement touched:
     * SQLite rolls back the hot journal on the way in.
     * @param {Pending[]} pending
     */
    recover(pending) {
        const seen = new Set();
        for (const p of pending) {
            if (seen.has(p.entry.localPath)) continue;
            seen.add(p.entry.localPath);
            try { p.entry.db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get(); } catch (err) {
                log.warn(`[${this.logPrefix}] could not recover ${p.entry.localPath} after a statement timeout:`, /** @type {Error} */ (err).message);
            }
        }
    }

    /** @param {ChildReply} msg */
    onReply(msg) {
        const p = this.inflight.get(msg?.id);
        if (!p) return;
        this.inflight.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(reviveBlobs(msg.result));
        else p.reject(Object.assign(new Error(msg.error?.message || 'statement failed'), msg.error?.code ? { code: msg.error.code } : {}));
        this.release();
    }

    /**
     * @param {ChildProcess} proc
     * @param {number | null} code
     * @param {NodeJS.Signals | null} signal
     */
    onExit(proc, code, signal) {
        if (this.child === proc) this.child = null;
        // Ended by us at a deadline: its statements already failed; the files
        // get their recovery read now that the locks are gone. Ended on its
        // own: whatever was in flight is lost.
        const pending = this.failFor(proc, new Error(`${this.entityLabel} statement process stopped (${signal || code})`));
        this.recover([...this.pendingRecovery.splice(0), ...pending]);
        this.release();
    }

    spawn() {
        const proc = fork(path.join(__dirname, 'sqliteStatementChild.js'), [], {
            serialization: 'advanced',
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            execArgv: [],
        });
        proc.on('message', (msg) => this.onReply(/** @type {ChildReply} */ (msg)));
        proc.on('error', (err) => log.warn(`[${this.logPrefix}] statement process error:`, err.message));
        proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
        proc.unref();
        proc.channel?.unref();
        return proc;
    }

    /** @param {number} id */
    onDeadline(id) {
        const p = this.inflight.get(id);
        if (!p) return;
        const victim = p.proc;
        if (this.child === victim) this.child = null;
        /** @type {Pending[]} */
        const again = [];
        const spare = (/** @type {Pending} */ q) => q !== p && !q.retried && RETRYABLE_OPS.has(q.op);
        this.pendingRecovery.push(...this.failFor(victim, new StatementTimeoutError(
            `${this.entityLabel} statement exceeded the ${this.timeoutMs} ms limit and was stopped`), spare, again));
        log.warn(`[${this.logPrefix}] statement exceeded ${this.timeoutMs} ms on ${path.basename(p.entry.localPath)}; stopping the statement process`);
        this.draining = new Promise((resolve) => victim.once('exit', () => { this.draining = null; resolve(); }));
        victim.kill('SIGKILL');
        // Waits for the stopped process to exit (run() awaits draining), once.
        for (const q of again) this.run(q.entry, q.op, q.args, true).then(q.resolve, q.reject);
    }

    /**
     * @param {RunnerHandle} entry
     * @param {StatementOp} op
     * @param {unknown[]} args
     * @param {boolean} [retried]  a second send after a stop; never sent a third time
     */
    async run(entry, op, args, retried = false) {
        // A killed process may still hold the file's lock for a moment; its
        // successor would only wait on it.
        while (this.draining) await this.draining;
        if (!this.child) this.child = this.spawn();
        const proc = this.child;
        return new Promise((resolve, reject) => {
            const id = ++this.seq;
            const timer = setTimeout(() => this.onDeadline(id), this.timeoutMs);
            this.inflight.set(id, { resolve, reject, entry, timer, proc, op, args, retried });
            this.hold();
            proc.send({ id, op, localPath: entry.localPath, args }, (err) => {
                if (err && this.inflight.has(id)) {
                    this.inflight.delete(id);
                    clearTimeout(timer);
                    reject(err);
                    this.release();
                }
            });
        });
    }

    stop() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        const victim = this.child;
        this.child = null;
        if (victim) {
            this.failFor(victim, new Error(`${this.entityLabel} statement process stopped`));
            victim.kill('SIGKILL');
        }
    }
}

/** Routes each statement to the lane of its page database's owner. */
class ProcessRunner {
    /** @param {{ timeoutMs: number, entityLabel: string, logPrefix: string, maxProcesses: number, idleMs: number }} opts */
    constructor({ timeoutMs, entityLabel, logPrefix, maxProcesses, idleMs }) {
        this.mode = /** @type {const} */ ('process');
        this.timeoutMs = timeoutMs;
        this.laneOpts = { timeoutMs, entityLabel, logPrefix, idleMs };
        this.maxProcesses = maxProcesses;
        /** @type {Map<string, StatementLane>} */
        this.lanes = new Map();
    }

    /** @param {string} key */
    laneFor(key) {
        const existing = this.lanes.get(key);
        if (existing) return existing;
        if (this.maxProcesses > 0 && this.lanes.size >= this.maxProcesses) {
            const idle = [...this.lanes].find(([, l]) => l.isIdle());
            if (!idle) return [...this.lanes.values()].reduce((a, b) => (b.inflight.size < a.inflight.size ? b : a));
            idle[1].retire();
            this.lanes.delete(idle[0]);
        }
        const lane = new StatementLane({
            ...this.laneOpts,
            onIdle: () => {
                if (this.lanes.get(key) !== lane) return;
                lane.retire();
                this.lanes.delete(key);
            },
        });
        this.lanes.set(key, lane);
        return lane;
    }

    /** @param {RunnerHandle} entry @param {StatementOp} op @param {unknown[]} args */
    run(entry, op, args) { return this.laneFor(String(entry.ownerId ?? '')).run(entry, op, args); }

    stop() {
        for (const lane of this.lanes.values()) lane.stop();
        this.lanes.clear();
    }
}

/** The deadline off: every statement runs on this thread, as before. */
class InProcessRunner {
    constructor() { this.mode = /** @type {const} */ ('in-process'); this.timeoutMs = 0; }
    /** @param {RunnerHandle} entry @param {StatementOp} op @param {unknown[]} args */
    async run(entry, op, args) { return STATEMENT_OPS[op](entry.db, ...args); }
    stop() {}
}

/**
 * @param {{ timeoutMs?: number, entityLabel: string, logPrefix: string, maxProcesses?: number, idleMs?: number }} opts
 */
function createStatementRunner({
    timeoutMs = statementTimeoutMs(), entityLabel, logPrefix,
    maxProcesses = envCount('SQLITE_STATEMENT_MAX_PROCESSES', DEFAULT_MAX_PROCESSES),
    idleMs = envCount('SQLITE_STATEMENT_IDLE_MS', DEFAULT_IDLE_MS),
}) {
    return timeoutMs > 0
        ? new ProcessRunner({ timeoutMs, entityLabel, logPrefix, maxProcesses, idleMs })
        : new InProcessRunner();
}

module.exports = {
    createStatementRunner, statementTimeoutMs, StatementTimeoutError, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_PROCESSES, DEFAULT_IDLE_MS, RETRYABLE_OPS,
};

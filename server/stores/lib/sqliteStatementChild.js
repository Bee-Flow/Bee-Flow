// @typecheck strict
'use strict';

/**
 * The statement process of the SQLite-blob engine, forked by
 * ./sqliteStatementRunner.js: it runs page-database statements so that a slow
 * one never blocks the server's event loop, and so that the runner can end it
 * (SIGKILL) at the deadline. The operating system then releases every file
 * lock the process held; SQLite's journal rolls back whatever the killed
 * statement had half-written the next time the file is opened.
 *
 * Messages in: { id, op, localPath, args }. Out: { id, ok: true, result } or
 * { id, ok: false, error: { message, code } }. Each connection is opened on
 * demand per file and kept for a while; a file replaced underneath it (the
 * engine re-downloads a blob to the same path) is recognised by its inode and
 * reopened. The process exits with its parent (IPC channel closed).
 */

const fs = require('fs');
const { bestEffort } = require('../../utils/bestEffort');
const { STATEMENT_OPS } = require('./sqliteBlobStatements');
const { openPageDatabase } = require('./sqliteOpen');

const IDLE_CLOSE_MS = 60_000;

/** @type {Map<string, { db: ReturnType<typeof openPageDatabase>, ino: number, lastUse: number }>} */
const open = new Map();

/** @param {ReturnType<typeof openPageDatabase>} db */
function closeQuietly(db) {
    try { db.close(); } catch (err) { bestEffort('sqliteStatementChild:close', err); }
}

/** @param {string} localPath */
function connectionFor(localPath) {
    const st = fs.statSync(localPath);
    const cached = open.get(localPath);
    if (cached && cached.ino === st.ino) {
        cached.lastUse = Date.now();
        return cached.db;
    }
    if (cached) {
        closeQuietly(cached.db);
        open.delete(localPath);
    }
    const db = openPageDatabase(localPath);
    open.set(localPath, { db, ino: st.ino, lastUse: Date.now() });
    return db;
}

function closeIdle() {
    const cutoff = Date.now() - IDLE_CLOSE_MS;
    for (const [localPath, c] of open) {
        if (c.lastUse < cutoff) {
            closeQuietly(c.db);
            open.delete(localPath);
        }
    }
}
setInterval(closeIdle, IDLE_CLOSE_MS).unref();

process.on('message', (/** @type {{ id: number, op: string, localPath: string, args: unknown[] }} */ msg) => {
    if (!msg || typeof msg !== 'object' || !process.send) return;
    const { id, op, localPath, args } = msg;
    try {
        const run = Object.prototype.hasOwnProperty.call(STATEMENT_OPS, op) ? STATEMENT_OPS[op] : null;
        if (!run) throw new Error(`Unknown statement operation: ${op}`);
        const result = run(connectionFor(localPath), ...(Array.isArray(args) ? args : []));
        process.send({ id, ok: true, result });
    } catch (err) {
        const e = /** @type {Error & { code?: string, statementIndex?: number }} */ (err);
        bestEffort('sqliteStatementChild:statement', e);
        // statementIndex: which batch statement changed no rows (batch_no_rows).
        process.send({ id, ok: false, error: { message: e?.message || String(err), code: e?.code, ...(Number.isInteger(e?.statementIndex) ? { statementIndex: e.statementIndex } : {}) } });
    }
});

process.on('disconnect', () => {
    for (const c of open.values()) closeQuietly(c.db);
    process.exit(0);
});

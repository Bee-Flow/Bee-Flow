// @typecheck strict
/**
 * Pre-built PGlite data directories, so a test does not pay for initdb (or for
 * the whole migration ladder) again in every file and every `beforeEach`.
 *
 *   newPglite()      a PGlite on a freshly initdb'd cluster: the same database
 *                    `new PGlite()` boots, ~0.5 s instead of ~1.9 s. Drop-in
 *                    for `new PGlite(options)` (an explicit dataDir /
 *                    loadDataDir in `options` is respected and bypasses this).
 *   ladderPglite()   a PGlite whose data directory is the result of the REAL
 *                    boot ladder (migrateDb.runMigrations) on an empty cluster:
 *                    every table every store creates, the ledger, the seeded
 *                    catalogues. For a test that needs the full schema but is
 *                    not itself about the ladder (the ladder's own tests keep
 *                    running it, step by step, on `newPglite()`).
 *
 * The data directory is `pg.dumpDataDir('gzip')` of a PGlite that was built
 * once, cached on disk and loaded with `new PGlite({ loadDataDir })` after that.
 *
 * Cache: server/node_modules/.cache/pglite-template (PGLITE_TEMPLATE_DIR
 * overrides). One file per kind, named by a key:
 *   empty   = pglite version
 *   ladder  = pglite version + sha256 of every non-test file of server/ (the
 *             DDL of every store, the data migrations, the catalogues): any
 *             edit to the server rebuilds it, a stale template is never read.
 * The file is `sha256(payload) + payload` and is checked on every read, so a
 * truncated or hand-edited file is dropped and rebuilt, not used.
 *
 * Parallel test processes: no lock. A missing template is built by a child
 * process (testUtils/pgliteTemplateBuild.js) that writes `<name>.<pid>.tmp` and
 * renames it into place; two processes that build at once both succeed and the
 * last rename wins with an equivalent file. The runner builds the empty one up
 * front (`node testUtils/pgliteTemplateBuild.js --prepare`).
 *
 * CLOSE WHAT YOU OPEN. A PGlite started from a data directory (this one, a
 * reopened dataDir) leaves a 10 s timer of its Postgres armed, so a test file
 * that never calls `pg.close()` does not exit: the runner reports it HUNG, and
 * node:test never prints its summary. (A plain `new PGlite()` exits without a
 * close, so a missing close only shows with a template.) `after(() => pg.close())`.
 *
 * PGLITE_TEMPLATE=off turns `newPglite()` back into a plain `new PGlite()`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PGlite } = require('@electric-sql/pglite');

const SERVER = path.join(__dirname, '..');
/** Bump when the file layout below changes. */
const FORMAT = 1;
/** Directories that never hold schema-defining source. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist']);
const SOURCE_FILE = /\.(c|m)?js$|\.mts$|\.ts$|\.json$|\.sql$|\.md$|\.txt$/;

/** The package's `exports` hides package.json, so find it beside the entry point. */
function pgliteVersion() {
    for (let dir = path.dirname(require.resolve('@electric-sql/pglite')); dir !== path.dirname(dir); dir = path.dirname(dir)) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
            const { name, version } = JSON.parse(fs.readFileSync(pkg, 'utf8'));
            if (name === '@electric-sql/pglite') return String(version);
        }
    }
    throw new Error('pgliteTemplate: cannot find the version of @electric-sql/pglite');
}
const cacheDir = () => process.env.PGLITE_TEMPLATE_DIR || path.join(SERVER, 'node_modules', '.cache', 'pglite-template');

/** sha256 over the path and content of every non-test file under server/. */
function sourceHash() {
    const h = crypto.createHash('sha256');
    /** @param {string} dir */
    const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
            if (!e.isFile() || !SOURCE_FILE.test(e.name) || /\.test\./.test(e.name)) continue;
            h.update(path.relative(SERVER, p)).update('\0').update(fs.readFileSync(p));
        }
    };
    walk(SERVER);
    return h.digest('hex');
}

/** @param {'empty' | 'ladder'} kind */
function templateFile(kind) {
    const key = crypto.createHash('sha256')
        .update(`${FORMAT}|${kind}|${pgliteVersion()}|${kind === 'ladder' ? sourceHash() : ''}`)
        .digest('hex').slice(0, 20);
    return path.join(cacheDir(), `${kind}-${key}.tgz`);
}

/**
 * The payload of a template file, or null when it is missing or does not
 * match its own checksum (a corrupt file is deleted so the next build replaces it).
 *
 * @param {string} file
 * @returns {Buffer | null}
 */
function readVerified(file) {
    /** @type {Buffer} */
    let raw;
    try { raw = fs.readFileSync(file); } catch { return null; }
    const payload = raw.subarray(32);
    const ok = raw.length > 32 && crypto.createHash('sha256').update(payload).digest().equals(raw.subarray(0, 32));
    if (!ok) { fs.rmSync(file, { force: true }); return null; }
    return payload;
}

/**
 * Atomic publish: write beside the target, rename onto it.
 *
 * @param {string} file
 * @param {Buffer} payload
 */
function writeAtomic(file, payload) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([crypto.createHash('sha256').update(payload).digest(), payload]));
    fs.renameSync(tmp, file);
    // Templates of an older key (another server version, another pglite) are dead weight.
    const prefix = path.basename(file).split('-')[0] + '-';
    for (const f of fs.readdirSync(path.dirname(file))) {
        if (f.startsWith(prefix) && f.endsWith('.tgz') && f !== path.basename(file)) {
            fs.rmSync(path.join(path.dirname(file), f), { force: true });
        }
    }
}

/**
 * Build `kind` in a child process (the ladder installs a db.js mock in
 * require.cache, which must not leak into the caller) and publish it.
 *
 * @param {'empty' | 'ladder'} kind
 */
function buildInChild(kind) {
    const res = spawnSync(
        process.execPath,
        ['--require', path.join(__dirname, 'registerFeatures.js'), path.join(__dirname, 'pgliteTemplateBuild.js'), '--build', kind],
        { cwd: SERVER, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (res.status !== 0) throw new Error(`pgliteTemplate: building the ${kind} template failed (exit ${res.status})\n${res.stdout}${res.stderr}`);
}

/** @type {Partial<Record<'empty' | 'ladder', Buffer | Error>>} */
const memo = {};

/**
 * The verified template payload, built first when it is missing or stale.
 *
 * @param {'empty' | 'ladder'} kind
 * @returns {Buffer}
 */
function templatePayload(kind) {
    const memoised = memo[kind];
    if (memoised instanceof Error) throw memoised;   // a failed build is not retried by every PGlite of the file
    if (memoised) return memoised;
    try {
        const file = templateFile(kind);
        let payload = readVerified(file);
        if (!payload) {
            buildInChild(kind);
            payload = readVerified(file);
            if (!payload) throw new Error(`pgliteTemplate: ${kind} template missing after the build (${file})`);
        }
        memo[kind] = payload;
        return payload;
    } catch (err) {
        memo[kind] = err instanceof Error ? err : new Error(String(err));
        throw memo[kind];
    }
}

/** @param {Buffer} payload */
const asBlob = (payload) => new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (new Uint8Array(payload.buffer, payload.byteOffset, payload.length))]);

/**
 * `new PGlite(options)` on a pre-initialised cluster. Falls back to a plain
 * PGlite when the template is off, when `options` already choose a data
 * directory, or when it cannot be built (the test then merely runs slower).
 *
 * @param {import('@electric-sql/pglite').PGliteOptions} [options]
 */
function newPglite(options = {}) {
    if (process.env.PGLITE_TEMPLATE === 'off' || options.dataDir || options.loadDataDir) return new PGlite(options);
    /** @type {Buffer} */
    let payload;
    try { payload = templatePayload('empty'); } catch { return new PGlite(options); }
    return new PGlite({ ...options, loadDataDir: asBlob(payload) });
}

/**
 * A PGlite holding the schema the real boot ladder leaves behind.
 *
 * @param {import('@electric-sql/pglite').PGliteOptions} [options]
 */
function ladderPglite(options = {}) {
    return new PGlite({ ...options, loadDataDir: asBlob(templatePayload('ladder')) });
}

module.exports = { newPglite, ladderPglite, templateFile, readVerified, writeAtomic, sourceHash };

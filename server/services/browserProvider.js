/**
 * Browser Provider — a thin Playwright client over a REMOTE Chromium.
 *
 * The server image no longer bakes in a Chromium binary. Instead, all in-process
 * browser work (PDF export, webpage thumbnails, SPA URL ingestion, and the
 * Tests Studio host-mode fallback) is driven against a long-lived, network-
 * isolated browser container that `pwtRunner.ensureBrowserSingleton()` manages
 * (or an external Playwright server via BROWSER_WS_ENDPOINT).
 *
 * Connection discipline (this is the whole point of the module):
 *   • We hold ONE persistent `chromium.connect()` for the process (`_conn`).
 *   • Each unit of work runs in its own `browser.newContext()` and only the
 *     CONTEXT is closed afterwards.
 *   • We NEVER call `browser.close()` during normal operation — on a
 *     `launchServer` host that would tear down the shared browser for everyone.
 *     Callers therefore never see a raw Browser; they get a context (via
 *     `withContext`) or a context they must close themselves (`newSharedContext`).
 *   • If the connection drops (singleton crashed / respawned), the next call
 *     transparently reconnects (and respawns the container via pwtRunner).
 *
 * Contexts are fully isolated (separate storage/cookies) and cheap, so a single
 * shared browser comfortably serves the low-volume export/thumbnail/ingest load.
 */

const DEFAULT_DEPS = {
    pwtRunner: require('./pwtRunner'),
    chromium: () => require('playwright').chromium,
};
let _deps = DEFAULT_DEPS;

const CONNECT_TIMEOUT_MS = parseInt(process.env.BROWSER_CONNECT_TIMEOUT_MS || '30000', 10);
// Dev-only escape hatch: launch a browser in-process when no remote backend is
// reachable. Requires a locally-installed browser (absent from the slim image),
// so this is OFF in production and only useful for native `npm start` dev runs.
const ALLOW_LOCAL = process.env.BROWSER_ALLOW_LOCAL_LAUNCH === 'true';
const LOCAL_LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

let _conn = null;          // persistent connected (or locally-launched) Browser
let _connecting = null;    // in-flight connect promise (dedupes concurrent first use)

function chromium() {
    return _deps.chromium();
}

/**
 * The code every "no browser to render with" failure carries, so a route can
 * answer with a sanitized 503 instead of a generic 500 (or, worse, these
 * operator-facing words). The detail stays in `err.message` for the log.
 */
const BACKEND_UNAVAILABLE = 'browser_backend_unavailable';

function backendUnavailable(detail, cause) {
    const err = new Error(
        `Browser backend unavailable (${detail}). Run the browser sidecar and set BROWSER_WS_ENDPOINT `
        + `to its Playwright server (ws://browser:9222/<path> in the self-host compose files), or mount `
        + `the Docker socket so the server can start the shared browser container itself. `
        + `BROWSER_ALLOW_LOCAL_LAUNCH only works for native dev with a locally installed browser; the `
        + `server image has none.`
    );
    err.code = BACKEND_UNAVAILABLE;
    if (cause) err.cause = cause;
    return err;
}

/** Did this error come from a missing or unreachable browser backend? */
function isBackendUnavailable(err) {
    return !!err && err.code === BACKEND_UNAVAILABLE;
}

async function establish() {
    let endpoint = null;
    try {
        endpoint = await _deps.pwtRunner.getBrowserEndpoint();
    } catch (err) {
        if (!ALLOW_LOCAL) throw backendUnavailable(err.message, err);
        endpoint = null; // fall through to dev-only local launch
    }

    let browser;
    try {
        if (endpoint) {
            browser = await chromium().connect(endpoint, { timeout: CONNECT_TIMEOUT_MS });
        } else {
            browser = await chromium().launch({ headless: true, args: LOCAL_LAUNCH_ARGS });
        }
    } catch (err) {
        // A sidecar that is stopped, or an endpoint with the wrong path, fails
        // here rather than in getBrowserEndpoint.
        throw backendUnavailable(err.message, err);
    }
    // Drop the cached handle the moment the remote browser goes away so the next
    // call reconnects/respawns instead of throwing on a dead socket.
    browser.on('disconnected', () => { if (_conn === browser) _conn = null; });
    return browser;
}

async function getConnection() {
    if (_conn && _conn.isConnected()) return _conn;
    if (_connecting) return _connecting;
    _connecting = establish()
        .then((b) => { _conn = b; return b; })
        .finally(() => { _connecting = null; });
    return _connecting;
}

/**
 * Create a context, retrying ONCE through a fresh connection if the persistent
 * one turns out to be dead (the failure surfaces here, on newContext). The retry
 * deliberately wraps only connection + context creation — never the caller's
 * work — so a bug in the caller is not re-run.
 */
async function newContextWithRetry(contextOptions) {
    try {
        const browser = await getConnection();
        return await browser.newContext(contextOptions || {});
    } catch (err) {
        _conn = null; // assume the connection is gone; force a clean reconnect
        const browser = await getConnection();
        return await browser.newContext(contextOptions || {});
    }
}

/**
 * Run `fn(context)` against an isolated context on the shared browser, then
 * close the context. The shared browser/connection is left intact.
 *
 * @param {object} contextOptions  passed to browser.newContext (viewport,
 *                                 userAgent, deviceScaleFactor, …) — all work
 *                                 over connect().
 * @param {(context: import('playwright').BrowserContext) => Promise<any>} fn
 */
async function withContext(contextOptions, fn) {
    const context = await newContextWithRetry(contextOptions);
    try {
        return await fn(context);
    } finally {
        try { await context.close(); } catch (_) { /* ignore */ }
    }
}

/**
 * Hand back an isolated context the CALLER owns. The caller MUST
 * `await context.close()` when done and MUST NOT close the browser. Used by the
 * Tests Studio host-mode fallback, whose explore/agent loops manage their own
 * page/context lifecycle.
 */
async function newSharedContext(contextOptions) {
    return newContextWithRetry(contextOptions);
}

/** Pass-through to the underlying remote ws endpoint (rarely needed directly). */
async function getBrowserEndpoint() {
    return _deps.pwtRunner.getBrowserEndpoint();
}

/** Tear down the persistent connection (e.g. on process shutdown). */
async function close() {
    const b = _conn;
    _conn = null;
    if (b) { try { await b.close(); } catch (_) { /* ignore */ } }
}

/**
 * Test seam: swap the runner and the Playwright `chromium` getter, and drop
 * any cached connection. No argument restores the real ones.
 */
function __setDepsForTests(over = null) {
    _deps = { ...DEFAULT_DEPS, ...(over || {}) };
    _conn = null;
    _connecting = null;
}

module.exports = {
    withContext, newSharedContext, getBrowserEndpoint, close,
    isBackendUnavailable, BACKEND_UNAVAILABLE, __setDepsForTests,
};

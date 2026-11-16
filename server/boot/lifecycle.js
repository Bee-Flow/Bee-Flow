// @typecheck
/** @typedef {import('express-serve-static-core').Express} Express */
'use strict';
/**
 * The process lifecycle of the server, moved verbatim out of server/index.js:
 *
 *   installProcessErrorHandlers  unhandledRejection / uncaughtException
 *   startServer                  auth-schema migrations, then listen, then the
 *                                startup checks, the webpage runtime reaper (and
 *                                its gated proxy) and the startup tasks
 *   installGracefulShutdown      SIGTERM / SIGINT: stop accepting connections, fail the
 *                                meeting-notes runs of this process, drain
 *                                the automation runner, stop the pushers, flush,
 *                                close Redis, the blob engines and OTEL, exit 0
 *
 * `deps` is the test seam (boot/bootChain.characterisation.test.js): each
 * collaborator falls back to the module the inline code required, at the moment
 * it required it — lazy stays lazy.
 */
const defaultLog = require('../telemetry/log');
const runtimeState = require('../utils/runtimeState.mts');
const { envInt } = require('../utils/envNumber.mts');
const { bestEffort } = require('../utils/bestEffort');

/** @param {{ log?: Log, proc?: NodeJS.Process }} [opts] */
function installProcessErrorHandlers({ log = defaultLog, proc = process } = {}) {
    proc.on('unhandledRejection', (reason, promise) => {
        log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
    proc.on('uncaughtException', (err) => {
        log.error('Uncaught Exception:', err);
        proc.exit(1);
    });
}

/**
 * The collaborators startServer takes from a test instead of requiring them.
 * @typedef {{ createServer?: typeof import('node:http').createServer,
 *   userStore?: { initDB(): Promise<unknown> }, authConfigStore?: { migrate(): Promise<unknown> },
 *   webpageRuntimeManager?: { startReaper(): void, isEnabled(): boolean },
 *   fullTierProxy?: { mountFullTierProxy(app: Express, server: import('node:http').Server): void } }} StartServerDeps
 */
/**
 * What startServer is started with; `terminalErrorHandler` is re-registered after the full-tier proxy mounts.
 * @typedef {{ app: Express, port: string | number, terminalErrorHandler: import('express').ErrorRequestHandler,
 *   runStartupChecks: () => void, runStartupTasks: () => void, log?: Log, proc?: NodeJS.Process,
 *   deps?: StartServerDeps }} StartServerArgs
 */
/**
 * Create the HTTP server and start it. Returns the server at once (the webpage
 * full-tier proxy attaches its WebSocket 'upgrade' listener to it) and the
 * startup promise, which never rejects: a failure is logged and exits 1.
 * @param {StartServerArgs} param0
 */
function startServer({ app, port, terminalErrorHandler, runStartupChecks, runStartupTasks, log = defaultLog, proc = process, deps = {} }) {
    // Captured so the (gated, off-by-default) webpage full-tier proxy can attach a
    // WebSocket 'upgrade' listener for Vite HMR — upgrade requests bypass the
    // Express app entirely and can only be intercepted on the underlying
    // http.Server.
    const server = (deps.createServer || require('node:http').createServer)(app);
    // An idle keep-alive connection must outlive the idle time-out of the proxy in
    // front of it (60 s for nginx and most load balancers). Node's own default is
    // 5 s: the proxy then reuses a connection the server has just closed and the
    // user gets a 502. The headers time-out stays above the keep-alive time-out.
    server.keepAliveTimeout = envInt('HTTP_KEEP_ALIVE_TIMEOUT_MS', 65_000, { min: 1000 });
    server.headersTimeout = Math.max(envInt('HTTP_HEADERS_TIMEOUT_MS', 66_000, { min: 1000 }), server.keepAliveTimeout + 1000);
    async function listen() {
        // Existing deployments must finish additive auth schema and transactional
        // secret migration before accepting requests. Any failure stops startup.
        await (deps.userStore || require('../stores/userStore')).initDB();
        await (deps.authConfigStore || require('../stores/authConfigStore')).migrate();
        server.listen(/** @type {number} */ (/** @type {unknown} */ (port)), '0.0.0.0', () => {
            log.info(`Server running on http://0.0.0.0:${port}`);
            // The listener answers from here on (liveness); "ready" waits for the boot
            // steps that the checks and tasks below register in this same tick.
            runtimeState.beginBoot();
            // Refuse-to-boot / NODE_ENV posture checks, the INIT_* first-boot wizard and
            // the durable HMAC secrets — see boot/startupTasks.js.
            runStartupChecks();

            // Webpage full-tier runtime (per-project Node/Vite dev container) — GATED
            // + INERT by default. startReaper() is always safe to call: it no-ops
            // unless WEBPAGE_FULL_RUNTIME_ENABLED=1 (see webpageRuntimeManager.js's
            // own gate). The proxy mount (http-proxy-middleware + the WS 'upgrade'
            // listener) is additionally only required — not just gated internally —
            // when the flag is on, so installs that never touch this feature never
            // load that dependency. No runner image is built from this repository
            // any more; enabling it in production needs its own image and a security
            // review first.
            const webpageRuntimeManager = deps.webpageRuntimeManager || require('../services/webpageRuntimeManager');
            webpageRuntimeManager.startReaper();
            if (webpageRuntimeManager.isEnabled()) {
                (deps.fullTierProxy || require('../routes/webpagesFullTierProxy')).mountFullTierProxy(app, server);
                log.info('[Server] Webpage full-tier runtime proxy mounted (WEBPAGE_FULL_RUNTIME_ENABLED=1).');
                // This proxy mounts once the server is already listening, i.e. BEHIND
                // the terminal error handler — and Express never routes an error
                // backwards. Re-register the handler so a proxy failure gets the same
                // generic body instead of falling through to the stack-printing default.
                // The earlier copy still wins for every layer that precedes it.
                app.use(terminalErrorHandler);
            }

            // Sanity probes, warmups, one-shot backfills and migrations, schedulers,
            // runners and periodic jobs — see boot/startupTasks.js.
            runStartupTasks();
        });
    }
    const started = listen().catch(err => {
        log.error('[Server] OAuth upgrade failed; refusing startup:', err.message);
        proc.exit(1);
    });
    return { server, started };
}

/**
 * The three calls the shutdown makes on the HTTP server.
 * @typedef {Pick<import('node:http').Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>} ClosableServer
 */
/**
 * Register the SIGTERM / SIGINT handlers. Returns the shutdown function.
 * `server` is the one startServer returned; without it (a test) the connection steps are skipped.
 * @param {{ otel: { shutdown: Function }, disconnectRedis: Function, server?: ClosableServer, log?: { info?: any, warn?: any }, proc?: NodeJS.Process, deps?: { automationRunner?: any, backgroundRun?: any, meetingRuns?: any, chatSignals?: any, configStore?: any, opsMetricsPush?: any, studioAppDbStore?: any, usageOpenObservePush?: any, webpageDbStore?: any } }} opts
 */
function installGracefulShutdown({ otel, disconnectRedis, server, log = defaultLog, proc = process, deps = {} }) {
    let _shuttingDown = false;
    /** @param {(server: ClosableServer) => void} step a connection step; one that throws must not stop the shutdown */
    const onServer = (step) => {
        if (!server) return;
        try { step(server); } catch (err) { bestEffort('boot/lifecycle:closeConnections', err); }
    };
    const shutdown = async (signal) => {
        if (_shuttingDown) return; // ignore a second signal while draining
        _shuttingDown = true;
        // The readiness probe answers "shutting down" from here on (routes/ready.js).
        runtimeState.beginShutdown();
        log.info(`[Server] ${signal} received, cleaning up...`);
        // Stop accepting connections and close the idle ones, so the proxy in front
        // sends new requests elsewhere instead of to a process that is about to exit.
        // Requests in flight keep their connection. NOT awaited: the callback of
        // close() waits for every connection, and one streaming chat (SSE) or
        // WebSocket would hold the shutdown for as long as it stays open.
        onServer((s) => s.close());
        // Drain in-flight automation runs FIRST: stop claiming new scheduled work
        // and wait (bounded) for running executions to finish, so a deploy doesn't
        // abandon a run mid-step and re-fire its side effects after restart. Bound
        // it under the orchestrator's termination grace (k8s default 30s).
        // App Studio background actions drain in parallel under the same bound; what does not
        // finish in time is marked interrupted (there is no resume).
        // Unset, not a number or not above 0 keeps the 25 s default (the behaviour of the old `|| 25_000`).
        const drainEnv = Number(process.env.AUTOMATION_DRAIN_TIMEOUT_MS);
        const drainMs = Number.isFinite(drainEnv) && drainEnv > 0 ? Math.floor(drainEnv) : 25_000;
        await Promise.all([
            // Meeting-notes runs live in this process and die with it: mark them
            // failed now, so the user sees Retry instead of a spinner until the
            // reaper comes round. First, while the database is surely there.
            (async () => {
                try {
                    const meetingRuns = deps.meetingRuns || require('../core/meetingNotes/processingRuns.mts');
                    const failed = await meetingRuns.failInFlight({ timeoutMs: 5000 });
                    if (failed) log.info(`[Server] ${failed} meeting note run(s) interrupted by the shutdown, marked failed for a retry`);
                } catch (e) { log.warn('[Server] marking interrupted meeting runs failed:', /** @type {Error} */ (e).message); }
            })(),
            (async () => {
                try {
                    const automationRunner = deps.automationRunner || require('../core/automationRunner');
                    if (typeof automationRunner.stop === 'function') {
                        await automationRunner.stop({ timeoutMs: drainMs });
                    }
                } catch (e) { log.warn('[Server] automation runner drain failed:', /** @type {Error} */ (e).message); }
            })(),
            (async () => {
                try {
                    const backgroundRun = deps.backgroundRun || require('../appStudio/backgroundRun.mts');
                    await backgroundRun.stop({ timeoutMs: Math.max(1000, drainMs - 2000) });
                } catch (e) { log.warn('[Server] background action drain failed:', /** @type {Error} */ (e).message); }
            })(),
        ]);
        // Connections whose request ended during the drain are idle now.
        onServer((s) => s.closeIdleConnections());
        try { (deps.usageOpenObservePush || require('../jobs/usageOpenObservePush')).stop(); } catch (err) { defaultLog.debug('best-effort', err); }
        try { (deps.opsMetricsPush || require('../jobs/opsMetricsPush')).stop(); } catch (err) { defaultLog.debug('best-effort', err); }
        // Chat signals: write the last minute of counters (bounded; a lost minute is acceptable, a hung shutdown is not).
        try { await Promise.race([(deps.chatSignals || require('../core/privacy/chatSignals')).flush(), new Promise(r => setTimeout(r, 2000).unref())]); } catch (err) { defaultLog.debug('best-effort', err); }
        try { (deps.configStore || require('../stores/configStore'))._stopInvalidationListener(); } catch (err) { defaultLog.debug('best-effort', err); }
        await disconnectRedis(); // shared ioredis client (caching and the session cache)
        // Flush the SQLite blob engines' dirty handles BEFORE exiting. Their own
        // SIGTERM listeners fire concurrently, but the process.exit() below used
        // to race them to death — an unawaited flush loses up to the debounce
        // window of committed app/webpage writes on every single deploy. Bounded
        // so a hung RustFS can't stall the pod past its termination grace.
        try {
            await Promise.race([
                Promise.allSettled([
                    (deps.studioAppDbStore || require('../stores/studioAppDbStore')).closeAll(),
                    (deps.webpageDbStore || require('../stores/webpageDbStore')).closeAll(),
                ]),
                new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
            ]);
        } catch (e) { log.warn('[Server] Blob-engine shutdown flush failed:', /** @type {Error} */ (e).message); }
        // Flush any buffered spans/metrics so a deploy doesn't drop the last batch.
        await otel.shutdown();
        // What is still open now (a streaming chat that outlasted the drain) ends here.
        onServer((s) => s.closeAllConnections());
        proc.exit(0);
    };
    proc.on('SIGTERM', () => shutdown('SIGTERM'));
    proc.on('SIGINT', () => shutdown('SIGINT'));
    return shutdown;
}

module.exports = { installProcessErrorHandlers, startServer, installGracefulShutdown };

/** @typedef {typeof defaultLog} Log */

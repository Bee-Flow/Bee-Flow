// @typecheck
/** @typedef {import('express-serve-static-core').Express} Express */
'use strict';
/**
 * The process lifecycle of the server, moved verbatim out of server/index.js:
 *
 *   installProcessErrorHandlers  unhandledRejection / uncaughtException
 *   startServer                  auth-schema migrations, then listen, then the
 *                                startup checks, the modules' afterListen (the
 *                                webpage runtime reaper and its gated proxy) and
 *                                the startup tasks
 *   installGracefulShutdown      SIGTERM / SIGINT: stop accepting connections, drain
 *                                the modules (meeting-notes runs, automation runner,
 *                                App Studio actions), stop the pushers, flush, close
 *                                Redis, the modules (blob engines) and OTEL, exit 0
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
 *   loader?: { afterListen(app: Express, server: import('node:http').Server, ctx: import('../modules/firstParty/contract').AfterListenContext): void } }} StartServerDeps
 */
/**
 * What startServer is started with; `terminalErrorHandler` goes to the modules' afterListen (a mount after listen registers it again).
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

            // The modules' wiring that needs the listening server (the webpage full-tier
            // runtime: firstParty/webpages.jobs.js). A mount added here sits BEHIND the
            // terminal error handler, so it gets the handler to register again.
            (deps.loader || require('../modules/firstParty/loader')).afterListen(app, server, { terminalErrorHandler, log });

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
 * @param {{ otel: { shutdown: Function }, disconnectRedis: Function, server?: ClosableServer, log?: { info?: any, warn?: any }, proc?: NodeJS.Process, deps?: { loader?: ShutdownLoader, chatSignals?: any, configStore?: any, opsMetricsPush?: any, usageOpenObservePush?: any } }} opts
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
        // Drain the modules FIRST, concurrently, under one shared budget: the meeting-notes
        // runs of this process are marked failed, in-flight automation runs finish (bounded)
        // so a deploy doesn't abandon a run mid-step, App Studio background actions drain
        // (firstParty/<id>.jobs.js drain). Bound it under the orchestrator's termination
        // grace (k8s default 30s); each module keeps its own bound inside it.
        // Unset, not a number or not above 0 keeps the 25 s default (the behaviour of the old `|| 25_000`).
        const drainEnv = Number(process.env.AUTOMATION_DRAIN_TIMEOUT_MS);
        const drainMs = Number.isFinite(drainEnv) && drainEnv > 0 ? Math.floor(drainEnv) : 25_000;
        const loader = deps.loader || require('../modules/firstParty/loader');
        await loader.drain({ timeoutMs: drainMs });
        // Connections whose request ended during the drain are idle now.
        onServer((s) => s.closeIdleConnections());
        try { (deps.usageOpenObservePush || require('../jobs/usageOpenObservePush')).stop(); } catch (err) { defaultLog.debug('best-effort', err); }
        try { (deps.opsMetricsPush || require('../jobs/opsMetricsPush')).stop(); } catch (err) { defaultLog.debug('best-effort', err); }
        // Chat signals: write the last minute of counters (bounded; a lost minute is acceptable, a hung shutdown is not).
        try { await Promise.race([(deps.chatSignals || require('../core/privacy/chatSignals')).flush(), new Promise(r => setTimeout(r, 2000).unref())]); } catch (err) { defaultLog.debug('best-effort', err); }
        try { (deps.configStore || require('../stores/configStore'))._stopInvalidationListener(); } catch (err) { defaultLog.debug('best-effort', err); }
        await disconnectRedis(); // shared ioredis client (caching and the session cache)
        // Flush the modules' SQLite blob engines (App Studio, web pages) BEFORE exiting
        // (firstParty/<id>.jobs.js close). Their own SIGTERM listeners fire concurrently,
        // and the process.exit() below would race them: an unawaited flush loses the
        // debounce window of committed writes. Bounded so a hung RustFS can't stall the
        // pod past its termination grace.
        await loader.close({ timeoutMs: 10_000 });
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
/** The part of the first-party loader the shutdown calls. @typedef {{ drain(opts: { timeoutMs: number }): Promise<void>, close(opts?: { timeoutMs?: number }): Promise<void> }} ShutdownLoader */

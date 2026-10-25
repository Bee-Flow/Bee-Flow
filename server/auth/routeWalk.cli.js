#!/usr/bin/env node
// @typecheck noImplicitAny
/**
 * Route walker — prints the app's real (method, path, gate-chain) table as JSON.
 *
 * WHY A CLI AND NOT A TEST HELPER: requiring server/index.js starts module-scope
 * timers (the AITaskRunner background runner logs "started (60s interval)" on
 * require, not inside listen). A `node --test` process that required it would
 * never exit. So the walk runs here, prints one JSON document, and exits; the
 * drift test execFileSync's it. That also confines the monkey-patching below to
 * a throwaway process instead of leaking into every other test in the run.
 *
 * WHY IT NEEDS NO PRODUCTION CHANGES: index.js calls app.listen() unconditionally
 * at module scope and exports nothing, which looks like a blocker. It isn't —
 * patching express.application.listen to return a fake server lets the module
 * load to completion without binding a port, and patching .use() captures the app
 * and every mount as it happens.
 *
 * THREE EXPRESS 5 FACTS THIS RELIES ON (probed on 5.2.1, and all three contradict
 * the usual advice):
 *   • `app._router` is undefined. It is `app.router`.
 *   • `layer.regexp` does not exist and `layer.path` is undefined until a match
 *     runs, so a mount prefix cannot be read off a layer.
 *   • The object you pass to `app.use()` is NOT kept as `layer.handle` — of 92
 *     top-level mounts, zero matched by identity.
 * Hence: we record (mountPath, routerFn) pairs at use() time and walk from those,
 * never from the stack. That is what makes nested routers, root mounts
 * (`app.use('/', ...)`) and duplicate mounts (/auth is mounted 5x) come out right.
 *
 * Usage: node auth/routeWalk.cli.js --out <file> [--pretty]
 *
 * Output goes to a FILE, not stdout: index.js:1 loads dotenv (which prints
 * "injected env (38) from ..\.env") and several stores log on init, so stdout is
 * not a clean channel and JSON.parse of it would fail.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..');

// ── 0. Refuse to phone home ──────────────────────────────────────────
// The repo .env sets OTEL_EXPORTER_OTLP_ENDPOINT, and telemetry/otel.js:22
// auto-enables on its mere presence — so an unguarded walk exports traces to the
// production observability endpoint. isEnabled() checks OTEL_ENABLED === 'false'
// FIRST (:21), so this wins regardless of the endpoint. A diagnostic that walks
// the route table must not emit production telemetry.
process.env.OTEL_ENABLED = 'false';
// Belt and braces: never bind a real port even if the listen patch below is
// somehow bypassed.
process.env.SERVER_PORT = '0';
process.env.PORT = '0';

// index.js:85-88 installs uncaughtException → process.exit(1). Get in first so a
// stray async hiccup during load reports instead of silently killing the walk.
process.on('uncaughtException', (err) => {
    process.stderr.write(`[routeWalk] uncaught: ${err && err.stack}\n`);
    process.exit(3);
});
process.on('unhandledRejection', () => { /* ignore: no requests are served here */ });

// ── 1. Neutralise the DB ─────────────────────────────────────────────
// ~45 stores self-execute initDB() on require. db.js
// are the only two `new Pool(` sites in the tree, so stubbing those two keeps
// every store's init from opening a socket.
/**
 * @param {string} absId
 * @param {unknown} exports
 */
function mock(absId, exports) {
    const resolved = require.resolve(absId);
    const m = new Module(resolved);
    m.exports = exports;
    m.loaded = true;
    require.cache[resolved] = m;
}

/**
 * @typedef {{ query: () => Promise<{ rows: unknown[] }>, release?: () => void }} FakeClient
 */
/** @returns {Promise<void>} */
const noopAsync = async () => undefined;
/**
 * @type {{
 *   run: () => Promise<void>,
 *   getOne: () => Promise<void>,
 *   getAll: () => Promise<unknown[]>,
 *   exec: () => Promise<void>,
 *   query: () => Promise<{ rows: unknown[] }>,
 *   getClient: () => Promise<FakeClient>,
 *   withTransaction: (fn: (client: FakeClient) => unknown) => Promise<unknown>,
 *   makeStoreInit: (tag: string, schemaFn: () => void) => () => Promise<void>,
 *   getRedis: () => null,
 *   pool: { query: () => Promise<{ rows: unknown[] }>, connect: () => Promise<FakeClient>, on: () => void },
 *   end: () => Promise<void>,
 * }}
 */
const fakeDb = {
    run: noopAsync,
    getOne: noopAsync,
    getAll: async () => [],
    exec: noopAsync,
    query: async () => ({ rows: [] }),
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    // Stores that build their init through the db.js helper rather than
    // hand-rolling it (datatableStore is the first) call this at require time.
    // testUtils/mockDb.js has carried the same shim since it was written; the
    // omission here was simply that no walked store had used it yet.
    makeStoreInit: (_tag, schemaFn) => {
        /** @type {Promise<void> | null} */
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn);
            return promise;
        };
    },
    getRedis: () => null,
    pool: { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }), on() {} },
    end: noopAsync,
};

mock(path.join(SERVER, 'db.js'), fakeDb);

// ── 2. Capture the app and every mount ───────────────────────────────
const express = require('express');
const { readGate } = require('./gateMeta');

/** router fn → [{ mountPath, child }] */
const SUBMOUNTS = new Map();
/** router fn → [gate fns applied at that router's own .use() with no path] */
const ROUTER_LEVEL = new Map();
/** @type {express.Application | null} */
let rootApp = null;

/**
 * Express keeps its internals untyped: a layer of a router's stack, and a router
 * (or the app) as far as this walk reads it.
 * @typedef {import('express').RequestHandler} Handler
 * @typedef {Handler & Record<symbol, Record<string, unknown> | undefined>} GateHandler
 * @typedef {{ route?: { path: string, methods?: Record<string, boolean>, stack?: Layer[] }, handle: Handler }} Layer
 * @typedef {{ stack?: Layer[], handle?: Handler & { stack?: Layer[] } }} RouterLike
 * @typedef {Handler & RouterLike} RouterFn
 * @typedef {string | RegExp | Array<string | RegExp>} MountPath
 * @typedef {MountPath | import('express-serve-static-core').RequestHandlerParams | RouterFn} UseArg
 * @typedef {{ name: string, gate: ReturnType<typeof readGate> }} ChainSlot
 * @typedef {{ id: string, method: string, path: string, mount: string, chain: ChainSlot[], handlerProbe: ReturnType<typeof probe> }} WalkedRoute
 */

/** @param {RouterFn} v */
const isRouterLike = (v) =>
    typeof v === 'function' && (v.stack || (v.handle && v.handle.stack) || v.name === 'router');

/**
 * @param {RouterLike | express.Application} parent
 * @param {UseArg[]} args
 */
function record(parent, args) {
    /** @type {MountPath} */
    let mountPath = '/';
    let rest = args;
    if (typeof args[0] === 'string' || args[0] instanceof RegExp || Array.isArray(args[0])) {
        mountPath = /** @type {MountPath} */ (args[0]);
        rest = args.slice(1);
    }
    for (const fn of rest) {
        if (typeof fn !== 'function') continue;
        if (isRouterLike(/** @type {RouterFn} */ (fn)) && /** @type {RouterFn} */ (fn).stack) {
            if (!SUBMOUNTS.has(parent)) SUBMOUNTS.set(parent, []);
            SUBMOUNTS.get(parent).push({ mountPath, child: fn });
        } else {
            // A non-router fn passed alongside a router IS a gate for that mount:
            //   app.use('/api/automation', requireLicenseFeature('automations'), router)
            // Recording it here is why no text-scan of index.js is needed.
            if (!ROUTER_LEVEL.has(parent)) ROUTER_LEVEL.set(parent, []);
            ROUTER_LEVEL.get(parent).push({ mountPath, fn });
        }
    }
}

express.application.listen = /** @type {typeof express.application.listen} */ (/** @type {unknown} */ (function fakeListen() {
    return { on() { return this; }, /**
     * @param {(() => void) | undefined} cb
     */
    close(/** @type {(() => void) | undefined} */ cb) { if (cb) cb(); return this; }, address: () => ({ port: 0 }), unref() { return this; } };
}));

const appUse = express.application.use;
/** @param {UseArg[]} args */
express.application.use = function patchedUse(...args) {
    if (!rootApp) rootApp = this;
    record(this, args);
    return appUse.apply(this, args);
};

const routerUse = express.Router.prototype.use;
/** @param {UseArg[]} args */
express.Router.prototype.use = function patchedRouterUse(...args) {
    record(this, args);
    return routerUse.apply(this, args);
};

// ── 3. Load the app ──────────────────────────────────────────────────
require(path.join(SERVER, 'index.js'));

// ── 4. Walk from the recorded pairs ──────────────────────────────────
/**
 * @param {string} base
 * @param {MountPath} seg
 */
const joinPath = (base, seg) => {
    const s = typeof seg === 'string' ? seg : String(seg);
    if (!s || s === '/') return base || '/';
    const joined = `${base === '/' ? '' : base}${s.startsWith('/') ? s : `/${s}`}`;
    return joined || '/';
};

/**
 * @param {Handler} fn
 * @returns {ChainSlot}
 */
const describeFn = (fn) => ({
    name: fn.name || 'anonymous',
    gate: readGate(/** @type {GateHandler} */ (fn)),
});

/** @type {WalkedRoute[]} */
const routes = [];
/** @type {Array<{ path: string, gates: Array<Record<string, unknown>> }>} */
const mounts = [];
/** @type {ChainSlot[]} */
const appMiddleware = [];

/**
 * App-level `app.use(fn)` with no path — helmet, session, body parsers, the
 * connector JWT shim — is PLUMBING, not per-route authorization. It applies to
 * everything equally and is untagged by design, so folding it into each route's
 * chain would bury ~10 useless slots per route (11k+ across the app) and make
 * "every gate is tagged" unenforceable.
 *
 * A sub-router's own `router.use(fn)` is a different matter: that IS how a
 * router applies requireAuth to all its routes, so it stays in the chain.
 * @param {RouterLike} router
 * @param {string} basePath
 * @param {ChainSlot[]} inheritedGates
 * @param {boolean} isRoot
 */
function walk(router, basePath, inheritedGates, isRoot) {
    const gatesHere = [...inheritedGates];

    for (const { mountPath, fn } of ROUTER_LEVEL.get(router) || []) {
        if (mountPath !== '/' && mountPath !== undefined) continue;
        if (isRoot) appMiddleware.push(describeFn(fn));
        else gatesHere.push(describeFn(fn));
    }

    const stack = router.stack || (router.handle && router.handle.stack) || [];
    for (const layer of stack) {
        if (!layer.route) continue;
        const methods = Object.keys(layer.route.methods || {})
            .filter((m) => layer.route.methods[m])
            .map((m) => m.toUpperCase())
            .sort();
        // slice(0, -1) drops the terminal handler: it is the route body, not a
        // gate. Keeping it would make "every chain slot must be tagged"
        // unsatisfiable for every route in the app.
        const chainLayers = (layer.route.stack || []).slice(0, -1);
        const chain = [...gatesHere, ...chainLayers.map((l) => describeFn(l.handle))];

        const full = joinPath(basePath, layer.route.path);
        for (const method of methods) {
            const terminal = (layer.route.stack || []).slice(-1)[0];
            let source = '';
            try { source = Function.prototype.toString.call(terminal.handle); } catch (_) { source = ''; }
            routes.push({
                id: `${method} ${full}`,
                method,
                path: full,
                mount: basePath,
                chain,
                handlerProbe: probe(source),
            });
        }
    }

    for (const { mountPath, child } of SUBMOUNTS.get(router) || []) {
        const childBase = joinPath(basePath, mountPath);
        const childGates = [...gatesHere];
        // Sibling gates at the mount site are gates for this mount by
        // construction:  app.use('/api/automation', requireFeature('automations'), router)
        for (const { mountPath: gp, fn } of ROUTER_LEVEL.get(router) || []) {
            if (gp === mountPath && gp !== '/') childGates.push(describeFn(fn));
        }
        mounts.push({ path: childBase, gates: childGates.filter((g) => g.gate).map((g) => g.gate) });
        walk(child, childBase, childGates, false);
    }
}

// ── 5. Probe the handler body ────────────────────────────────────────
// The walker holds the handler FUNCTION, so its source is readable — no AST
// parser (server/ has no devDependencies), and no file:line evidence that rots.
// Attribution is the function's own text, which cannot be misattributed the way
// a line-based scan misattributes adminRoutes.js:32-114's module-level helpers.
const DIRECT = /\bisSuperAdmin\s*\(|\bhasPermission\s*\(|\bgetUserPermissions\s*\(|session\s*\??\.\s*isAdmin|\bresolveUserOrgIds\s*\(|\bperms\s*\.\s*includes\s*\(|\bisOrgAdmin|\bresolveEntitlements\s*\(|\bcanUseCapability\s*\(/;
// Per-file helpers that hide a gate behind one call, e.g. ai/config.js's
// isAdminUser(req) — a grep for `isSuperAdmin(` finds none of those.
const WRAPPER = /\b(?:is|has|can|assert|ensure|check|require|resolve|guard)[A-Z]\w*\s*\(\s*req\b/;

/**
 * @param {string} source
 */
function probe(source) {
    if (!source) return { direct: false, wrapper: false, hits: [], readable: false };
    /** @type {string[]} */
    const hits = [];
    const direct = DIRECT.test(source);
    const wrapper = WRAPPER.test(source);
    if (direct) hits.push(...(source.match(DIRECT) || []).slice(0, 1));
    if (wrapper) hits.push(...(source.match(WRAPPER) || []).slice(0, 1));
    return { direct, wrapper, hits, readable: true };
}

if (!rootApp) {
    process.stderr.write('[routeWalk] never saw an app.use() — did express.application.use get replaced?\n');
    process.exit(2);
}

walk(/** @type {RouterLike} */ (rootApp), '', [], true);

const out = {
    stats: {
        mounts: mounts.length,
        routes: routes.length,
        appMiddleware: appMiddleware.length,
        taggedChainSlots: routes.reduce((n, r) => n + r.chain.filter((c) => c.gate).length, 0),
        untaggedChainSlots: routes.reduce((n, r) => n + r.chain.filter((c) => !c.gate).length, 0),
        // Routes whose entire chain carries no gate tag at all — either genuinely
        // public, or gated inside the handler where a walk cannot see it.
        ungatedRoutes: routes.filter((r) => !r.chain.some((c) => c.gate)).length,
        // requireAuth and nothing else: the population whose real gate, if any,
        // lives in the handler body.
        authOnlyRoutes: routes.filter((r) => {
            const gates = r.chain.filter((c) => c.gate).map((c) => c.gate.axis);
            return gates.length > 0 && gates.every((a) => a === 'auth');
        }).length,
        probedHandlers: routes.filter((r) => r.handlerProbe.readable).length,
        flaggedHandlers: routes.filter((r) => r.handlerProbe.direct || r.handlerProbe.wrapper).length,
    },
    appMiddleware,
    mounts,
    routes,
};

const json = JSON.stringify(out, null, process.argv.includes('--pretty') ? 2 : 0);
const outIdx = process.argv.indexOf('--out');
if (outIdx !== -1 && process.argv[outIdx + 1]) {
    fs.writeFileSync(process.argv[outIdx + 1], json);
} else {
    // Fallback: sentinel-delimited, so a caller can still recover the document
    // from a stdout that dotenv and the stores have written to.
    process.stdout.write(`\n---BF-ROUTE-WALK-BEGIN---\n${json}\n---BF-ROUTE-WALK-END---\n`);
}
process.exit(0);

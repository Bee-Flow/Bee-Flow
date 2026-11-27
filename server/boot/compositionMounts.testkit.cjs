'use strict';
/**
 * The mount recorder of boot/composition.mounts.characterisation.test.js: a
 * child process that loads the real server/index.js and writes, in stack order,
 * everything mounted on the Express app (and on the /ai router) to a JSON file.
 *
 *   cd server && node boot/compositionMounts.testkit.cjs <out.json> [default|mcp]
 *
 * It is not a second app loader: like scripts/api-reference-walk.cjs it installs
 * its recording patches and then requires auth/routeWalk.cli.js, which stubs the
 * database, fakes listen() and ends with process.exit(0); the recording is
 * written from the 'exit' handler. Anything that mounts after listen() (the
 * webpage full-tier proxy and its second terminal error handler, both behind
 * WEBPAGE_FULL_RUNTIME_ENABLED=1) is therefore not in it.
 *
 * One entry per app.use() CALL (all its functions are its chain), one per
 * app.get()/post() route, one per stray stack layer. A function in a chain is
 * described by kind (router | gate | fn), name, its gate tag (auth/gateMeta.js)
 * and the class the route contract gives it (auth/routeContract.js chainClass);
 * a router by a sha256 of its sorted "METHOD path" table, sub-routers included.
 *
 * NODE_ENV is 'production' here so the production-only static mounts and the SPA
 * fallback of boot/staticAssets.js are recorded; fs.existsSync answers true for
 * the built SPA (agent-hub/dist), which need not exist. Nothing reads it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..');
const outFile = process.argv[2];
if (!outFile) {
    process.stderr.write('usage: compositionMounts.testkit.cjs <out.json> [default|mcp] (cwd: server/)\n');
    process.exit(2);
}
const loaderOut = path.join(os.tmpdir(), `bf-composition-mounts-${process.pid}.json`);

// ── 0. A deterministic environment ───────────────────────────────────
// The mount switches in their default state (unset), or the three MCP switches on
// with `mcp` as the second argument. The repo .env must not decide what is mounted
// (the same rule as the API reference).
const SWITCHES = ['STUDIO_MCP_ENABLED', 'AUTOMATION_MCP_ENABLED', 'CMS_MCP_ENABLED', 'SEARCH_ROUTER_ENABLED', 'WEBPAGE_FULL_RUNTIME_ENABLED'];
for (const name of SWITCHES) delete process.env[name];
if (process.argv[3] === 'mcp') for (const name of SWITCHES.slice(0, 3)) process.env[name] = '1';
process.env.NODE_ENV = 'production';
require(require.resolve('dotenv', { paths: [SERVER] })).config = () => ({ parsed: {} });
const DIST = path.resolve(SERVER, '..', 'agent-hub', 'dist');
const realExists = fs.existsSync;
fs.existsSync = (p) => (typeof p === 'string' && (p === DIST || p.startsWith(`${DIST}${path.sep}`))) || realExists(p);

const express = require(require.resolve('express', { paths: [SERVER] }));
const { readGate } = require('../auth/gateMeta');
const { chainClass, show } = require('../auth/routeContract');

// ── 1. Record every use() call, with its place in the stack ──────────
/** @type {any} */
let rootApp = null;
/** @type {Array<{ mountPath: unknown, fns: Function[], start: number, count: number }>} */
const appCalls = [];
/** router → its use() calls, in order */
const routerCalls = new WeakMap();

/** @param {any[]} args */
function splitArgs(args) {
    let mountPath;
    let rest = args;
    if (typeof args[0] === 'string' || args[0] instanceof RegExp || Array.isArray(args[0])) {
        mountPath = args[0];
        rest = args.slice(1);
    }
    return { mountPath, fns: rest.flat(Infinity).filter((f) => typeof f === 'function') };
}

const appUse = express.application.use;
express.application.use = function recordAppUse(...args) {
    if (!rootApp) rootApp = this;
    const start = this === rootApp && this.router ? this.router.stack.length : -1;
    const result = appUse.apply(this, args);
    if (this === rootApp) appCalls.push({ ...splitArgs(args), start, count: this.router.stack.length - start });
    return result;
};

const routerUse = express.Router.prototype.use;
express.Router.prototype.use = function recordRouterUse(...args) {
    const start = this.stack.length;
    const result = routerUse.apply(this, args);
    if (!routerCalls.has(this)) routerCalls.set(this, []);
    routerCalls.get(this).push({ ...splitArgs(args), start, count: this.stack.length - start });
    return result;
};

// ── 2. Describe what was recorded ────────────────────────────────────
const TAG_FIELDS = ['axis', 'id', 'kind', 'anyOf', 'feature', 'licenseFeature', 'param', 'minGrade', 'orgAdminBypass', 'platform'];

/** @param {any} fn */
const asRouter = (fn) => {
    const r = typeof fn.routerForWalk === 'function' ? fn.routerForWalk() : fn;
    return r && Array.isArray(r.stack) ? r : null;
};

/** @param {unknown} p */
const pathText = (p) => (p === undefined ? null : Array.isArray(p) ? p.map(String).join(',') : String(p));

/** @param {string} base @param {string} seg */
function join(base, seg) {
    if (!seg || seg === '/') return base || '/';
    return `${base === '/' ? '' : base}${seg.startsWith('/') ? seg : `/${seg}`}`;
}

/**
 * Every "METHOD path" a router answers, relative to its mount, sub-routers included.
 * @param {any} router @param {string} base @param {string[]} out @param {number} depth
 */
function routeTable(router, base, out, depth) {
    if (depth > 12) return out;
    const calls = routerCalls.get(router) || [];
    router.stack.forEach((/** @type {any} */ layer, /** @type {number} */ i) => {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
            for (const p of [].concat(layer.route.path)) for (const m of methods) out.push(`${m.toUpperCase()} ${join(base, String(p))}`);
            return;
        }
        const call = calls.find((c) => i >= c.start && i < c.start + c.count);
        const fn = call && call.fns[i - call.start];
        const child = fn && asRouter(fn);
        if (child) for (const seg of pathText(call.mountPath)?.split(',') || ['/']) routeTable(child, join(base, seg), out, depth + 1);
    });
    return out;
}

/** @param {any} fn */
function describeFn(fn) {
    const name = fn.name || 'anonymous';
    const router = asRouter(fn);
    if (router) {
        const table = [...new Set(routeTable(router, '', [], 0))].sort();
        const fingerprint = crypto.createHash('sha256').update(table.join('\n')).digest('hex').slice(0, 16);
        return { kind: 'router', name, routes: table.length, fingerprint };
    }
    const tag = readGate(fn);
    if (!tag) {
        const cls = chainClass({ method: '', path: '', gates: [], middleware: [name] });
        return cls ? { kind: 'fn', name, gate: show(cls) } : { kind: 'fn', name };
    }
    /** @type {Record<string, unknown>} */
    const kept = {};
    for (const key of TAG_FIELDS) if (tag[key] !== undefined) kept[key] = tag[key];
    const cls = chainClass({ method: '', path: '', gates: [tag], middleware: [name] });
    return { kind: 'gate', name, gate: cls ? show(cls) : null, tag: kept };
}

/** @param {any} router @param {typeof appCalls} calls */
function entriesOf(router, calls) {
    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    const stack = router.stack;
    for (let i = 0; i < stack.length; i += 1) {
        const call = calls.find((c) => c.start === i && c.count > 0);
        if (call) {
            entries.push({ type: 'use', path: pathText(call.mountPath), chain: call.fns.map(describeFn) });
            i += call.count - 1;
            continue;
        }
        const layer = stack[i];
        if (layer.route) {
            const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).sort();
            const chain = layer.route.stack.slice(0, -1).map((/** @type {any} */ l) => describeFn(l.handle));
            entries.push({ type: 'route', path: pathText(layer.route.path), methods, chain });
            continue;
        }
        entries.push({ type: 'layer', path: null, chain: [describeFn(layer.handle)] });
    }
    return entries;
}

/** The router of the /ai mount: its sub-routers are the second recording. */
function aiRouter() {
    const call = appCalls.find((c) => c.mountPath === '/ai');
    const fn = call && call.fns.find((f) => asRouter(f));
    return fn ? asRouter(fn) : null;
}

// ── 3. Load the app, write on exit ───────────────────────────────────
process.argv = [process.argv[0], path.join(SERVER, 'auth', 'routeWalk.cli.js'), '--out', loaderOut];
process.on('exit', (code) => {
    try {
        if (code !== 0) return;
        if (!rootApp) throw new Error('the app was never seen: express.application.use is no longer how index.js mounts');
        const ai = aiRouter();
        if (!ai) throw new Error('no router mounted at /ai');
        const out = { app: entriesOf(rootApp.router, appCalls), ai: entriesOf(ai, routerCalls.get(ai) || []) };
        fs.writeFileSync(outFile, JSON.stringify(out));
    } catch (err) {
        process.stderr.write(`compositionMounts: ${err && /** @type {Error} */ (err).stack}\n`);
        process.exitCode = 3;
    } finally {
        try { fs.unlinkSync(loaderOut); } catch (_) { /* never written */ }
    }
});

require('../auth/routeWalk.cli.js');

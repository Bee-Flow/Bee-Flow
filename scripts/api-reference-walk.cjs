#!/usr/bin/env node
/**
 * api-reference-walk — dump the app's real route table, with each route's gates
 * and its zod request schemas as JSON Schema. The input of
 * scripts/gen-api-reference.mjs; run by it, not by hand:
 *
 *   cd server && node ../scripts/api-reference-walk.cjs <out.json>
 *
 * It changes nothing in server/. It loads the real app in this process by
 * borrowing server/auth/routeWalk.cli.js (database stubbed, no port bound; the
 * same loader the access-registry drift test trusts) and, from patches installed
 * BEFORE any route file is required, records what it needs to read the router
 * afterwards:
 *
 *   - every Router#use call: which function sat at which index of which router's
 *     stack, under which mount path. Express keeps neither the path nor the
 *     function on the layer. The index is what makes the gates ORDER-AWARE: a
 *     route registered before `router.use(requireAuth)` is not behind it (the
 *     public webhook trigger is exactly that), which routeWalk.cli.js, built to
 *     count gates, does not model.
 *   - every `validate({ body, query, params })` of core/http/validate.js: the
 *     schemas it was built from, and a unique name on its middleware
 *     (`validateRequest#7`) to find them again in a route's chain.
 *
 * Gates are the tags server/auth/gateMeta.js puts on authorization middleware.
 * Untagged named middleware is reported by name and not interpreted.
 *
 * The walk is written from an 'exit' handler, because routeWalk.cli.js ends with
 * process.exit(0). Any other exit code writes nothing and the caller fails.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = process.cwd();
const outFile = process.argv[2];
if (!outFile) {
    process.stderr.write('usage: api-reference-walk.cjs <out.json> (cwd: server/)\n');
    process.exit(2);
}
if (!fs.existsSync(path.join(SERVER, 'index.js')) || !fs.existsSync(path.join(SERVER, 'node_modules'))) {
    process.stderr.write(`api-reference-walk: ${SERVER} is not an installed server/ directory (run npm ci there)\n`);
    process.exit(2);
}

const serverRequire = (/** @type {string} */ id) => require(require.resolve(id, { paths: [SERVER] }));
const loaderOut = path.join(os.tmpdir(), `bf-api-reference-loader-${process.pid}.json`);

// ── 1. Remember the schemas behind every validate({ ... }) ───────────
/** @type {Array<{ body?: unknown, query?: unknown, params?: unknown }>} */
const schemaRegistry = [];
const validateModule = require(path.join(SERVER, 'core', 'http', 'validate.js'));
const realValidate = validateModule.validate;
validateModule.validate = function validateWithRegistry(/** @type {{ body?: unknown, query?: unknown, params?: unknown }} */ schemas) {
    const middleware = realValidate(schemas);
    const id = schemaRegistry.push(schemas) - 1;
    Object.defineProperty(middleware, 'name', { value: `validateRequest#${id}`, configurable: true });
    return middleware;
};

// ── 2. Remember every Router#use, with its place in the stack ────────
// A developer's local .env must not change what is mounted: the reference is the
// same on every machine (the environment comes from the caller, see gen-api-reference.mjs).
serverRequire('dotenv').config = () => ({ parsed: {} });
const express = serverRequire('express');

/** @typedef {string | RegExp | Array<string | RegExp>} MountPath */
/** @type {WeakMap<object, Map<number, { mountPath: MountPath, fn: any }>>} router → stack index → what was used */
const USES = new WeakMap();
let useMismatches = 0;
/** @type {any} */
let rootApp = null;

const appUse = express.application.use;
express.application.use = function patchedAppUse(/** @type {any[]} */ ...args) {
    if (!rootApp) rootApp = this;
    return appUse.apply(this, args);
};

const routerUse = express.Router.prototype.use;
express.Router.prototype.use = function patchedRouterUse(/** @type {any[]} */ ...args) {
    /** @type {MountPath} */
    let mountPath = '/';
    let rest = args;
    if (typeof args[0] === 'string' || args[0] instanceof RegExp || Array.isArray(args[0])) {
        mountPath = args[0];
        rest = args.slice(1);
    }
    const fns = rest.flat(Infinity).filter((/** @type {unknown} */ f) => typeof f === 'function');
    const before = this.stack.length;
    const result = routerUse.apply(this, args);
    if (this.stack.length - before !== fns.length) {
        useMismatches += 1;
    } else {
        if (!USES.has(this)) USES.set(this, new Map());
        fns.forEach((/** @type {any} */ fn, /** @type {number} */ i) => USES.get(this).set(before + i, { mountPath, fn }));
    }
    return result;
};

// ── 3. Zod → JSON Schema ─────────────────────────────────────────────
const { z } = serverRequire('zod');
const SCHEMA_PARTS = ['body', 'query', 'params'];

/**
 * @param {unknown} schema
 * @returns {Record<string, unknown> | null} null when zod cannot express it
 */
function toJsonSchema(schema) {
    try {
        const json = /** @type {Record<string, unknown>} */ (z.toJSONSchema(/** @type {any} */ (schema), {
            target: 'draft-2020-12',
            io: 'input',
            unrepresentable: 'any',
            cycles: 'throw',
            reused: 'inline',
        }));
        delete json.$schema;
        return json;
    } catch (_) {
        return null;
    }
}

/** @param {number} id */
function schemasOf(id) {
    const declared = schemaRegistry[id] || {};
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const part of SCHEMA_PARTS) {
        const schema = /** @type {Record<string, unknown>} */ (declared)[part];
        if (!schema) continue;
        out[part] = toJsonSchema(schema) || { description: 'Recursive schema; the shape is defined in the route source.' };
    }
    return out;
}

// ── 4. A route's chain: gates, middleware names, schemas ─────────────
const { readGate } = require(path.join(SERVER, 'auth', 'gateMeta.js'));

/** Gate fields worth publishing: what is required, never the internal prose. */
const GATE_FIELDS = ['axis', 'id', 'kind', 'anyOf', 'feature', 'licenseFeature', 'param', 'minGrade', 'orgAdminBypass', 'platform'];

/** @param {Record<string, unknown> | null} gate */
function publicGate(gate) {
    if (!gate) return null;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of GATE_FIELDS) if (gate[key] !== undefined) out[key] = gate[key];
    return out;
}

// Slots that are plumbing, not access: the list the access tests use, the anonymous
// arrows nothing can be said about, and body/upload handling that never looks at who
// the caller is.
const PLUMBING = new Set([
    ...require(path.join(SERVER, 'auth', 'accessRegistry.js')).plumbingNames,
    'anonymous', '', 'bodySizeGuard', 'sizeGuard', 'rejectSqlKeys', 'jsonOnly', 'uploadErrorHandler',
    'withDocumentEncryptionSession', 'attachSiteId', 'stampExport', 'receiveWallpaper',
    'clipUploadMiddleware', 'importSiteUpload', 'uploadFile',
]);

/** @param {Function[]} chain */
function describeChain(chain) {
    /** @type {Array<Record<string, unknown>>} */
    const gates = [];
    /** @type {string[]} */
    const middleware = [];
    /** @type {Record<string, unknown>} */
    let schemas = {};
    for (const fn of chain) {
        const name = fn.name || 'anonymous';
        const m = /^validateRequest#(\d+)$/.exec(name);
        if (m) {
            schemas = { ...schemas, ...schemasOf(Number(m[1])) };
            continue;
        }
        const gate = publicGate(readGate(fn));
        if (gate) {
            if (!gates.some((g) => JSON.stringify(g) === JSON.stringify(gate))) gates.push(gate);
        } else if (!PLUMBING.has(name) && !middleware.includes(name)) {
            // Named but untagged: it may well be an access check (requireAdmin),
            // so it is reported by name and not interpreted.
            middleware.push(name);
        }
    }
    return { gates, middleware, schemas };
}

// The handler body check of routeWalk.cli.js (DIRECT / WRAPPER), kept in step by
// hand: it says "this handler looks at who the caller is", nothing more.
const DIRECT = /\bisSuperAdmin\s*\(|\bhasPermission\s*\(|\bgetUserPermissions\s*\(|session\s*\??\.\s*isAdmin|\bresolveUserOrgIds\s*\(|\bperms\s*\.\s*includes\s*\(|\bisOrgAdmin|\bresolveEntitlements\s*\(|\bcanUseCapability\s*\(/;
const WRAPPER = /\b(?:is|has|can|assert|ensure|check|require|resolve|guard)[A-Z]\w*\s*\(\s*req\b/;

/** @param {Function} handler */
function handlerChecksCaller(handler) {
    try {
        const source = Function.prototype.toString.call(handler);
        return DIRECT.test(source) || WRAPPER.test(source);
    } catch (_) {
        return false;
    }
}

// ── 5. Walk the stacks, in order ─────────────────────────────────────
/** @param {string} base @param {string} seg */
function joinPath(base, seg) {
    if (!seg || seg === '/') return base || '/';
    const joined = `${base === '/' ? '' : base}${seg.startsWith('/') ? seg : `/${seg}`}`;
    return joined || '/';
}

/** Does a use() at `prefix` cover something at `target`? */
const covers = (/** @type {string} */ prefix, /** @type {string} */ target) =>
    prefix === '/' || target === prefix || target.startsWith(`${prefix}/`);

/** The static string paths of a mount path; a RegExp covers nothing we can name. */
const stringPaths = (/** @type {MountPath} */ mountPath) =>
    (Array.isArray(mountPath) ? mountPath : [mountPath]).filter((p) => typeof p === 'string');

/** @type {Array<Record<string, unknown>>} */
const routes = [];
const MAX_DEPTH = 12;

/**
 * @param {any} router
 * @param {string} base
 * @param {Array<{ fn: Function, prefix: string }>} inherited  use() functions of the parents that may cover routes in here
 * @param {boolean} isRoot
 * @param {number} depth
 */
function walkRouter(router, base, inherited, isRoot, depth) {
    if (depth > MAX_DEPTH) return;
    const uses = USES.get(router) || new Map();
    /** @type {Array<{ fn: Function, prefix: string }>} */
    const local = [];
    (router.stack || []).forEach((/** @type {any} */ layer, /** @type {number} */ i) => {
        if (layer.route) {
            const own = layer.route.stack.map((/** @type {any} */ l) => l.handle);
            const terminal = own[own.length - 1];
            const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]).sort();
            // A route path is a string, a RegExp (shown as its source) or an array of those.
            for (const routePath of [].concat(layer.route.path)) {
                const full = joinPath(base, String(routePath));
                const gates = [...inherited, ...local].filter((g) => covers(g.prefix, full)).map((g) => g.fn);
                const described = describeChain([...gates, ...own.slice(0, -1)]);
                for (const method of methods) {
                    routes.push({ method: method.toUpperCase(), path: full, ...described, probedHandler: handlerChecksCaller(terminal) });
                }
            }
            return;
        }
        const use = uses.get(i);
        if (!use) return;
        if (typeof use.fn.stack !== 'undefined' && Array.isArray(use.fn.stack)) {
            for (const seg of stringPaths(use.mountPath).length ? stringPaths(use.mountPath) : ['/']) {
                const childBase = joinPath(base, seg);
                walkRouter(use.fn, childBase, [...inherited, ...local].filter((g) => covers(g.prefix, childBase) || g.prefix.startsWith(`${childBase}/`)), false, depth + 1);
            }
            return;
        }
        // The app's own path-less middleware (helmet, session, body parsers) is plumbing
        // for every route alike and stays out of each route's chain.
        if (isRoot && use.mountPath === '/') return;
        for (const seg of stringPaths(use.mountPath)) local.push({ fn: use.fn, prefix: joinPath(base, seg) });
    });
}

// ── 6. Load the app, then write on exit ──────────────────────────────
process.env.OTEL_ENABLED = 'false';
process.argv = [process.argv[0], path.join(SERVER, 'auth', 'routeWalk.cli.js'), '--out', loaderOut];

process.on('exit', (code) => {
    try {
        if (code !== 0) return;
        if (!rootApp) throw new Error('the app was never seen: express.application.use is no longer how index.js mounts');
        if (useMismatches > 0) throw new Error(`${useMismatches} Router#use call(s) added a different number of layers than functions; the stack indexes cannot be trusted`);
        walkRouter(rootApp.router, '', [], true, 0);
        fs.writeFileSync(outFile, JSON.stringify({ routes }));
    } catch (err) {
        process.stderr.write(`api-reference-walk: ${err && /** @type {Error} */ (err).stack}\n`);
        process.exitCode = 3;
    } finally {
        try { fs.unlinkSync(loaderOut); } catch (_) { /* never written */ }
    }
});

require(path.join(SERVER, 'auth', 'routeWalk.cli.js'));

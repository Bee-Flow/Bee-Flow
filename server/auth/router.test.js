/**
 * auth/router.js is the /auth HTTP surface; auth/index.js is only the facade
 * that re-exports the auth gates and helpers.
 *
 * WHY: auth/index.js used to build the /auth router itself, so every
 * `require('../auth')` for a gate (a store, a feature, core/kb) also loaded
 * all seven auth route files and everything they import. A middleware import
 * then dragged the whole auth HTTP surface into its module graph, and the
 * cycles through it with it. The router now lives in auth/router.js and only
 * the composition root (server/index.js) mounts it.
 *
 * Two contracts pinned here:
 *   1. requiring auth/index.js (in a fresh process) loads no auth route file
 *      and not auth/router.js; `router` is still exported, as a lazy getter;
 *   2. server/index.js is the only module that requires auth/router.js
 *      (besides auth/index.js's own lazy `router` getter, which runs only when
 *      something reads that key).
 *
 * Run: cd server && node --test auth/router.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..');
const AUTH = __dirname;

/** The files auth/router.js mounts, plus anything named like an auth router. */
function isAuthRouteFile(file) {
    if (!file.startsWith(AUTH + path.sep)) return false;
    const rel = path.relative(AUTH, file);
    return rel === 'router.js'
        || /Routes\.js$/.test(rel)
        || rel === 'connectorBootstrap.js';
}

test('requiring auth/index.js loads no auth route file', () => {
    // A fresh process: this file's own module cache says nothing about what
    // auth/index.js pulls in on its own.
    // What it loaded is read off the module tree (each module's `children`),
    // so nothing here touches the module system's cache.
    const script = `
        const auth = require(${JSON.stringify(path.join(AUTH, 'index.js'))});
        const seen = new Set();
        const visit = (m) => { if (seen.has(m.filename)) return; seen.add(m.filename); m.children.forEach(visit); };
        module.children.forEach(visit);
        const loaded = [...seen];
        const d = Object.getOwnPropertyDescriptor(auth, 'router');
        process.stdout.write(JSON.stringify({
            loaded,
            routerIsGetter: !!(d && typeof d.get === 'function' && d.enumerable),
            plainKeys: Object.keys(auth).filter((k) => k !== 'router'
                && Object.getOwnPropertyDescriptor(auth, k).writable === true).length,
            keys: Object.keys(auth).length,
        }));
        process.exit(0);
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
        cwd: SERVER,
        env: { ...process.env, NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 60_000,
    });
    const { loaded, routerIsGetter, plainKeys, keys } = JSON.parse(out.trim().split('\n').pop());

    const routeFiles = loaded.filter(isAuthRouteFile).map((f) => path.relative(SERVER, f));
    assert.deepStrictEqual(routeFiles, [],
        'auth/index.js must not load the /auth routers; mount auth/router.js from server/index.js instead');
    assert.ok(loaded.some((f) => f === path.join(AUTH, 'permissions.js')), 'the facade still re-exports auth/permissions');

    // `router` stays an export (lazy), and every other key stays a plain
    // writable property: testUtils/routeHarness.js openGates patches them.
    assert.strictEqual(routerIsGetter, true, '`router` is a lazy, enumerable getter on auth/index.js');
    assert.strictEqual(plainKeys, keys - 1, 'every export except `router` is a plain writable property');
});

test('only server/index.js requires auth/router.js (plus the lazy getter)', () => {
    const SKIP = new Set(['node_modules', 'migrations', 'assets', 'prompts']);
    const target = path.join(AUTH, 'router.js');
    const importers = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue; }
            if (!/\.(c|m)?js$/.test(e.name) || /\.test\.(c|m)?js$/.test(e.name)) continue;
            const src = fs.readFileSync(full, 'utf8');
            for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
                const resolved = path.resolve(path.dirname(full), m[1]);
                if (resolved === target || `${resolved}.js` === target) {
                    importers.push(path.relative(SERVER, full));
                }
            }
        }
    };
    walk(SERVER);
    assert.deepStrictEqual([...new Set(importers)].sort(), [path.join('auth', 'index.js'), 'index.js'],
        'auth/router.js is the /auth HTTP surface: only the composition root (server/index.js) mounts it; '
        + 'auth/index.js may reach it only through its lazy `router` getter');
});

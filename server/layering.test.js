/**
 * Guard: the dependency rule from ARCHITECTURE.md, enforced.
 *
 * Layers, and the one rule — dependencies point DOWNWARD only:
 *
 *     routes/          (API)       may require anything
 *     features         (product)   may require core + platform, NOT each other
 *     core/            (Bee Flow)  may require platform, NOT a feature
 *     platform         (infra)     may require platform
 *
 * Without this enforced, one convenience import quietly turns two modules into
 * one, and the next reader cannot tell a layer from a folder.
 *
 * A CLASSIFICATION NOTE, because the data corrected the document. `license/`
 * and `modules/` were first written down as features. They are not: they answer
 * "what tier is this org on, which capabilities does it hold" — the same kind of
 * cross-cutting question as auth, and core/entitlements/ is *supposed* to
 * depend on them. Ten "violations" were really one wrong label.
 *
 * TWO MORE OF THE SAME, found the same way — see layerOf() below. `core/
 * entitlements/` answers that identical question and belongs beside license/
 * and modules/; and the 35 Express routers inside `auth/` are API surface, not
 * platform. Mislabelling those routers had a concrete cost: `core/http/
 * validate` lives under core/, so a single zod schema in an auth router read as
 * a platform -> core violation. With the guard at its baseline and no headroom,
 * that put all 29 unvalidated auth routes out of reach.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// Product surfaces: one user-facing thing each, independent of one another.
const FEATURES = new Set([
    'cms', 'cmsBuilder', 'learning', 'support', 'compliance',
    'appStudio', 'legal', 'eval', 'pipeline', 'mcpServers', 'playbooks',
]);

// Infrastructure: knows nothing about a specific product surface.
const PLATFORM = new Set([
    'stores', 'auth', 'utils', 'middleware', 'telemetry', 'testUtils',
    'license', 'modules', 'shared', 'i18n', 'config', 'entitlements',
]);

// Measured when this guard landed. Lower them when you remove an edge; never
// raise them.
const PLATFORM_UPWARD_BASELINE = 46;
const LICENSE_MODULES_CYCLE = 9;
const ROUTES_UPWARD_BASELINE = 0;

// Composition roots: wiring routers together is their whole job, so an edge
// into a router is not them reaching upward for something.
const COMPOSITION_ROOTS = new Set(['index.js', path.join('auth', 'index.js')]);

/** `auth/loginRoutes.js`, `auth/login/currentUserRoutes.js`, … */
const AUTH_ROUTER = /^auth[\\/].*Routes\.js$/;

/** Platform subtrees that live under core/ but answer a platform question. */
const PLATFORM_UNDER_CORE = [path.join('core', 'entitlements')];

/**
 * Which layer a path belongs to — normally its top-level directory, with the
 * two refinements the classification note records. A path may be a file or a
 * directory; both arrive here relative to ROOT.
 */
function layerOf(rel) {
    if (AUTH_ROUTER.test(rel)) return 'routes';
    if (PLATFORM_UNDER_CORE.some(d => rel === d || rel.startsWith(d + path.sep))) return 'entitlements';
    return rel.split(path.sep)[0];
}

const SKIP = new Set(['node_modules', 'migrations', 'prompts', 'assets']);
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, out); }
        else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(full);
    }
    return out;
}

const REQUIRE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function edges() {
    const out = [];
    for (const file of walk(ROOT)) {
        const rel = path.relative(ROOT, file);
        const from = layerOf(rel);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(REQUIRE)) {
            const target = path.relative(ROOT, path.resolve(path.dirname(file), m[1]));
            if (target.startsWith('..')) continue;
            const to = layerOf(target);
            if (to === from) continue;
            out.push({ from, to, rel, target });
        }
    }
    return out;
}

const ALL = edges();

test('core/ never requires a product feature', () => {
    const bad = [...new Set(ALL.filter(e => e.from === 'core' && FEATURES.has(e.to))
        .map(e => `${e.rel} -> ${e.target}`))];
    assert.deepStrictEqual(bad, [],
        'core must not depend on a feature — the feature should pass it in:\n  ' + bad.join('\n  '));
});

test('one feature never requires another', () => {
    const bad = [...new Set(ALL.filter(e => FEATURES.has(e.from) && FEATURES.has(e.to))
        .map(e => `${e.rel} -> ${e.target}`))];
    assert.deepStrictEqual(bad, [],
        'two features needing the same thing means it belongs in core or platform:\n  ' + bad.join('\n  '));
});

test('the upward pull into routes/ does not grow', () => {
    // index.js is the composition root — mounting every router is its job.
    const bad = [...new Set(ALL
        .filter(e => e.to === 'routes' && !COMPOSITION_ROOTS.has(e.rel))
        .map(e => `${e.rel} -> ${e.target}`))];
    // Zero, and it stays zero: the support feature's five edges are gone
    // (notifyStaff, renderCannedBody and the SSE bus live in support/ now,
    // which is what the services were reaching through the route for), and the
    // MCP signer the token CLI needed is auth/mcpToken.js. Whatever a module
    // below routes/ is reaching up for was never HTTP — move it down instead of
    // raising this.
    assert.ok(bad.length <= ROUTES_UPWARD_BASELINE,
        `upward edges into routes/ grew from ${ROUTES_UPWARD_BASELINE} to ${bad.length}:\n  ` + bad.join('\n  '));
});

test('platform -> core/feature edges do not grow', () => {
    const bad = ALL.filter(e => PLATFORM.has(e.from) && (e.to === 'core' || FEATURES.has(e.to)));
    assert.ok(bad.length <= PLATFORM_UPWARD_BASELINE,
        `platform -> core/feature edges grew from ${PLATFORM_UPWARD_BASELINE} to ${bad.length}`);
});

test('the license <-> modules cycle does not grow', () => {
    const n = ALL.filter(e =>
        (e.from === 'license' && e.to === 'modules') ||
        (e.from === 'modules' && e.to === 'license')).length;
    assert.ok(n <= LICENSE_MODULES_CYCLE,
        `license<->modules edges grew from ${LICENSE_MODULES_CYCLE} to ${n}; break the cycle rather than adding to it`);
});

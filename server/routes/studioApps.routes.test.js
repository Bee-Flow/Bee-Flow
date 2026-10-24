// @typecheck
/**
 * The route table of /api/studio-apps (routes/studioApps.js), pinned.
 *
 * A characterisation test for the split of studioApps.js into
 * routes/studioApps/*: whatever file a handler lives in, the router must keep
 * answering the same method + path with the same middleware chain, and every
 * literal path (`/catalog`, `/templates`, `/mine`, `/usage`, `/import`) must
 * still be matched BEFORE the `/:id` route of the same method that would
 * otherwise swallow it. The handlers' behaviour is pinned by
 * studioApps.test.js; this file pins the shape that test cannot see.
 *
 * Run: cd server && node --test routes/studioApps.routes.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');

h.recordDb();
const router = require('./studioApps');

/** Every route the router answers, in matching order, sub-routers flattened. */
function routeTable(r) {
    const out = [];
    for (const layer of r.stack) {
        if (layer.route) {
            out.push({
                method: Object.keys(layer.route.methods).join(','),
                path: layer.route.path,
                chain: layer.route.stack.map((s) => s.handle),
            });
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
            // A sub-router mounted with router.use('/', …): its routes are ours.
            out.push(...routeTable(layer.handle));
        } else {
            out.push({ method: 'use', path: '*', chain: [layer.handle] });
        }
    }
    return out;
}

const table = routeTable(router);
const nameOf = (fn) => fn.name || '<anonymous>';
const line = (r) => `${r.method} ${r.path} ${r.chain.map(nameOf).join(' ')}`;

const EXPECTED = [
    'delete /:id requireAuth <anonymous> <anonymous>',
    'delete /:id/public-pages/:token requireAuth <anonymous> <anonymous>',
    'delete /templates/:templateId requireAuth <anonymous> <anonymous>',
    'get / requireAuth <anonymous>',
    'get /:id requireAuth <anonymous>',
    'get /:id/public-pages requireAuth <anonymous>',
    'get /:id/ref requireAuth validateRequest <anonymous>',
    'get /:id/runtime requireAuth validateRequest <anonymous>',
    'get /:id/versions requireAuth <anonymous>',
    'get /catalog requireAuth <anonymous>',
    'get /mine requireAuth <anonymous>',
    'get /templates requireAuth <anonymous>',
    'get /templates/:templateId requireAuth <anonymous>',
    'get /templates/:templateId/export requireAuth <anonymous> validateRequest stampExport <anonymous>',
    'get /usage requireAuth <anonymous> <anonymous>',
    'patch /:id/nextcloud-menu requireAuth <anonymous> validateRequest <anonymous>',
    'patch /:id/publish requireAuth <anonymous> validateRequest <anonymous>',
    'post / requireAuth <anonymous> validateRequest <anonymous>',
    'post /:id/check requireAuth validateRequest <anonymous>',
    'post /:id/public-pages requireAuth <anonymous> <anonymous>',
    'post /:id/template-upgrade requireAuth <anonymous> <anonymous>',
    'post /:id/versions/:versionId/restore requireAuth <anonymous> <anonymous>',
    'post /import requireAuth <anonymous> rateLimitMiddleware <anonymous>',
    'post /templates/import requireAuth <anonymous> rateLimitMiddleware <anonymous>',
    'put /:id requireAuth <anonymous> validateRequest <anonymous>',
    'put /:id/definition requireAuth <anonymous> validateRequest <anonymous>',
];

test('the router answers exactly the same routes with the same middleware chain', () => {
    assert.deepStrictEqual(table.map(line).sort(), EXPECTED);
});

test('a literal path is matched before the parameter route of the same method that would take it', () => {
    const pattern = (p) => new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}$`);
    for (const [i, param] of table.entries()) {
        if (!param.path.includes(':')) continue;
        for (const [j, literal] of table.entries()) {
            if (i === j || literal.method !== param.method) continue;
            if (!pattern(param.path).test(literal.path)) continue;
            assert.ok(j < i, `${literal.method.toUpperCase()} ${literal.path} must come before ${param.path}, `
                + 'or the parameter route answers it');
        }
    }
});

test('the write routes share ONE manage_apps gate, the second link of their chain', () => {
    const WRITES = [
        'delete /:id', 'delete /:id/public-pages/:token', 'delete /templates/:templateId',
        'get /templates/:templateId/export', 'patch /:id/nextcloud-menu', 'patch /:id/publish',
        'post /', 'post /:id/public-pages', 'post /:id/template-upgrade',
        'post /:id/versions/:versionId/restore', 'post /import', 'post /templates/import',
        'put /:id', 'put /:id/definition',
    ];
    const gates = new Set(WRITES.map((key) => {
        const r = table.find((x) => `${x.method} ${x.path}` === key);
        assert.ok(r, `${key} is gone`);
        return r.chain[1];
    }));
    assert.strictEqual(gates.size, 1, 'every write route goes through the same requireManageApps instance');
    // And the reads do not: using an app is not building one.
    for (const key of ['get /:id', 'get /:id/runtime', 'get /', 'get /catalog']) {
        const r = table.find((x) => `${x.method} ${x.path}` === key);
        assert.ok(!gates.has(r.chain[1]), `${key} must not require manage_apps`);
    }
});

test('each rate limiter is its own instance (separate budgets for template and app imports)', () => {
    const limiter = (key) => table.find((x) => `${x.method} ${x.path}` === key).chain[2];
    assert.notStrictEqual(limiter('post /import'), limiter('post /templates/import'));
});

/**
 * routeProbe — "would METHOD path reach a handler?" against Express 5 stacks.
 *
 * Nested routers, mount-prefix stripping, `:param` filling, method matching
 * (HEAD via GET), a non-router input, the Express-4 `layer.regexp` fallback
 * and — the one property that matters for a probe run inside the live server —
 * that probing leaves the router's layers untouched.
 *
 * Run: cd server && node --test --test-force-exit compliance/dataPortability/routeProbe.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { isMounted, samplePath, _matchLayer } = require('./routeProbe');

function buildApp() {
    const leaf = express.Router();
    leaf.get('/:id/export', (req, res) => res.end());
    leaf.post('/:id/package/export', (req, res) => res.end());
    leaf.get('/sites/:siteId/export', (req, res) => res.end());
    leaf.all('/:id/anything', (req, res) => res.end());
    const parent = express.Router();
    parent.use('/', leaf);
    const app = express();
    app.use('/api/automation', parent);
    // A second router mounted at a different prefix must not answer for the first.
    const other = express.Router();
    other.get('/export/all', (req, res) => res.end());
    app.use('/agents/memory', other);
    return { app, leaf, parent, other };
}

test('samplePath fills :params, strips optional groups and wildcards, keeps a leading slash', () => {
    assert.equal(samplePath('/api/automation/:id/export'), '/api/automation/probe-id/export');
    assert.equal(samplePath('/api/cms/sites/:siteId/export'), '/api/cms/sites/probe-siteId/export');
    assert.equal(samplePath('/a/:id(\\d+)/b'), '/a/probe-id/b');
    assert.equal(samplePath('/a{/:opt}/b'), '/a/b');
    assert.equal(samplePath('/files/*splat'), '/files/probe-wild');
    assert.equal(samplePath('no-slash'), '/no-slash');
    assert.equal(samplePath('/x/:id/export?format=json'), '/x/probe-id/export');
    assert.equal(samplePath(''), '/');
});

test('a route behind two nested mounts is found with its full public path', () => {
    const { app } = buildApp();
    assert.equal(isMounted(app, 'GET', '/api/automation/:id/export'), true);
    assert.equal(isMounted(app, 'POST', '/api/automation/:id/package/export'), true);
    assert.equal(isMounted(app, 'GET', '/api/automation/sites/:siteId/export'), true);
    assert.equal(isMounted(app, 'GET', '/agents/memory/export/all'), true);
});

test('method must match; HEAD is satisfied by a GET route; .all() answers every method', () => {
    const { app } = buildApp();
    assert.equal(isMounted(app, 'POST', '/api/automation/:id/export'), false, 'GET route does not answer POST');
    assert.equal(isMounted(app, 'get', '/api/automation/:id/export'), true, 'method is case-insensitive');
    assert.equal(isMounted(app, 'HEAD', '/api/automation/:id/export'), true);
    assert.equal(isMounted(app, 'DELETE', '/api/automation/:id/anything'), true);
});

test('the wrong prefix, an unknown path or a bare router with the prefix included → false', () => {
    const { app, leaf } = buildApp();
    assert.equal(isMounted(app, 'GET', '/api/x/:id/export'), false);
    assert.equal(isMounted(app, 'GET', '/agents/memory/:id/export'), false, 'the memory router has no :id/export');
    assert.equal(isMounted(app, 'GET', '/api/automation/:id/exports'), false);
    // Probing the leaf directly uses the leaf's own paths, not the app's.
    assert.equal(isMounted(leaf, 'GET', '/:id/export'), true);
    assert.equal(isMounted(leaf, 'GET', '/api/automation/:id/export'), false);
});

test('non-router inputs never throw and answer false', () => {
    assert.equal(isMounted(null, 'GET', '/x'), false);
    assert.equal(isMounted(undefined, 'GET', '/x'), false);
    assert.equal(isMounted({}, 'GET', '/x'), false);
    assert.equal(isMounted(42, 'GET', '/x'), false);
    assert.equal(isMounted(() => {}, 'GET', '/x'), false);
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, 'router', { get() { throw new Error('boom'); } });
    assert.equal(isMounted(throwingGetter, 'GET', '/x'), false);
});

test('the default method is GET', () => {
    const { app } = buildApp();
    assert.equal(isMounted(app, undefined, '/api/automation/:id/export'), true);
    assert.equal(isMounted(app, undefined, '/api/automation/:id/package/export'), false);
});

test('probing does not mutate the live layers (params/path stay untouched)', () => {
    const { app, leaf, parent } = buildApp();
    const before = JSON.stringify(
        [...leaf.stack, ...parent.stack].map(l => ({ params: l.params, path: l.path, keys: l.keys })),
    );
    isMounted(app, 'GET', '/api/automation/:id/export');
    isMounted(app, 'GET', '/api/automation/nothing/here/at/all');
    const after = JSON.stringify(
        [...leaf.stack, ...parent.stack].map(l => ({ params: l.params, path: l.path, keys: l.keys })),
    );
    assert.equal(after, before);
});

test('Express-4 style layers (regexp, no matchers) are matched via the regexp fallback', () => {
    const layer = { regexp: /^\/legacy\/?(?=\/|$)/i, handle: express.Router() };
    assert.deepEqual(_matchLayer(layer, '/legacy/x'), { path: '/legacy' });
    assert.equal(_matchLayer(layer, '/other/x'), null);
    assert.equal(_matchLayer(null, '/x'), null);
    assert.deepEqual(_matchLayer({ slash: true }, '/anything'), { path: '' });
});

test('a matcher that throws on an undecodable segment counts as no match, not a crash', () => {
    const layer = { matchers: [() => { throw new URIError('bad escape'); }] };
    assert.equal(_matchLayer(layer, '/%E0%A4%A'), null);
});

test('recursion is capped so a self-referencing stack cannot loop forever', () => {
    const cyclic = express.Router();
    cyclic.use('/', cyclic); // pathological, but the probe must survive it
    assert.equal(isMounted(cyclic, 'GET', '/never/there'), false);
});

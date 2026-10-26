// @typecheck strict
'use strict';
/**
 * BFSF-468 - unmatched requests get one fixed label, never the raw path.
 *
 * Run: node --test boot/requestTiming.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _normalizeRoute, UNMATCHED_ROUTE } = require('./requestTiming');

test('a request with no matched route is labelled __unmatched__', () => {
    assert.equal(UNMATCHED_ROUTE, '__unmatched__');
    assert.equal(_normalizeRoute({ baseUrl: '', path: '/wp-admin/xmlrpc.php' }), UNMATCHED_ROUTE);
    assert.equal(_normalizeRoute({ baseUrl: '/api', path: '/random/123456789' }), UNMATCHED_ROUTE);
});

test('a matched route keeps its templated label', () => {
    assert.equal(_normalizeRoute({ baseUrl: '/api/agents', route: { path: '/:id' } }), '/api/agents/:id');
    assert.equal(_normalizeRoute({ baseUrl: '/api/x/12345', route: { path: '/y' } }), '/api/x/:id/y');
});

test('a matched RegExp route is not unmatched and keeps its mount point', () => {
    assert.equal(_normalizeRoute({ baseUrl: '/api/module-assets', route: { path: /^\/x/ } }), '/api/module-assets/__regex__');
    assert.equal(_normalizeRoute({ baseUrl: '', route: { path: /^\/x/ } }), '/__regex__');
    assert.notEqual(_normalizeRoute({ baseUrl: '', route: { path: ['/a', '/b'] } }), UNMATCHED_ROUTE);
});

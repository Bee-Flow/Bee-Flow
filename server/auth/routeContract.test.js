'use strict';

/**
 * The pure half of the route contract: classification and comparison, fed
 * with hand-made routes. The real-router half is routes.contract.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rc = require('./routeContract');

const ctx = () => ({ surface: { routes: [] }, registry: { routes: {}, untriaged: [] }, open: new Map() });
const route = (over) => ({ method: 'GET', path: '/x', gates: [], middleware: [], probedHandler: false, ...over });

test('tagged gates win over everything, strongest first', () => {
    assert.equal(rc.classify(route({ gates: [{ axis: 'auth' }, { axis: 'platform', kind: 'superAdmin' }] }), ctx()).gate, 'platform');
    assert.deepEqual(rc.classify(route({ gates: [{ axis: 'auth' }, { axis: 'rbac', anyOf: ['b', 'a'] }] }), ctx()), { gate: 'permission', anyOf: ['a', 'b'] });
    assert.equal(rc.classify(route({ gates: [{ axis: 'auth' }, { axis: 'scope', kind: 'orgAdminOfParam' }] }), ctx()).gate, 'scope');
    assert.equal(rc.classify(route({ gates: [{ axis: 'auth' }, { axis: 'scoped', minGrade: 'editor' }] }), ctx()).gate, 'scoped');
    assert.equal(rc.classify(route({ gates: [{ axis: 'auth' }, { axis: 'capability', id: 'x' }] }), ctx()).gate, 'auth');
});

test('an untagged middleware counts only when its name says it decides who the caller is', () => {
    assert.equal(rc.classify(route({ middleware: ['requireAdmin'] }), ctx()).gate, 'middleware');
    assert.equal(rc.classify(route({ middleware: [{ name: 'apiKeyAuth' }] }), ctx()).gate, 'middleware');
    assert.equal(rc.classify(route({ middleware: ['webpageChatGate'] }), ctx()).gate, 'middleware');
    for (const name of ['trainingGate', 'requireJson', 'requireCloud', 'requireMirror', 'requireCapability', 'requireModule', 'customIntegrationsFeatureGate', 'googleSessionHydration']) {
        assert.equal(rc.classify(route({ middleware: [name] }), ctx()).gate, 'unaccounted', name);
    }
});

test('without a chain gate: registry, sweep evidence, open list, probe, else unaccounted', () => {
    const c = ctx();
    c.registry.routes['GET /x'] = { enforcement: 'handler' };
    assert.equal(rc.classify(route(), c).gate, 'handler');
    c.registry.routes['GET /x'] = { enforcement: 'public', note: 'a reason that is long enough to be checked by a reviewer' };
    assert.equal(rc.classify(route(), c).gate, 'open');
    const u = ctx();
    u.registry.untriaged = ['GET /x'];
    assert.equal(rc.classify(route(), u).gate, 'untriaged');
    const s = ctx();
    s.surface.routes = [{ method: 'GET', path: '/x', evidence: ['handler'], file: 'routes/x.js' }];
    assert.equal(rc.classify(route(), s).gate, 'handler');
    const o = ctx();
    o.surface.routes = [{ method: 'GET', path: '/x', evidence: [], file: 'routes/x.js' }];
    o.open.set('file:routes/x.js', { reden: 'the file serves published marketing pages to anonymous crawlers' });
    assert.equal(rc.classify(route(), o).gate, 'open');
    o.open.clear();
    o.open.set('mount:/x', 'a mount-wide exemption with a reason long enough to check');
    assert.equal(rc.classify(route(), o).gate, 'open');
    assert.equal(rc.classify(route({ probedHandler: true }), ctx()).gate, 'handler');
    assert.equal(rc.classify(route(), ctx()).gate, 'unaccounted');
});

test('a router mounted twice is held to its weakest mount', () => {
    const built = rc.buildContract([
        route({ gates: [{ axis: 'auth' }, { axis: 'rbac', anyOf: ['a'] }] }),
        route({ gates: [{ axis: 'auth' }] }),
    ], ctx());
    assert.equal(built['GET /x'].gate, 'auth');
    const union = rc.buildContract([
        route({ gates: [{ axis: 'rbac', anyOf: ['a'] }] }),
        route({ gates: [{ axis: 'rbac', anyOf: ['b'] }] }),
    ], ctx());
    assert.deepEqual(union['GET /x'].anyOf, ['a', 'b']);
});

test('compare: a weaker class, a widened permission list, a new route, a stale route', () => {
    const recorded = {
        'GET /a': { gate: 'platform' },
        'GET /b': { gate: 'permission', anyOf: ['admin_x'] },
        'GET /c': { gate: 'auth' },
        'GET /gone': { gate: 'auth' },
    };
    const observed = {
        'GET /a': { gate: 'permission', anyOf: ['admin_x'] },
        'GET /b': { gate: 'permission', anyOf: ['admin_x', 'manage_users'] },
        'GET /c': { gate: 'platform' },
        'GET /new': { gate: 'auth' },
        'GET /open': { gate: 'open', reason: 'short' },
        'GET /none': { gate: 'unaccounted' },
    };
    const d = rc.compareContract(recorded, observed);
    assert.deepEqual(d.weakened.map((w) => w.id), ['GET /a', 'GET /b']);
    assert.deepEqual(d.missing, ['GET /new', 'GET /open', 'GET /none']);
    assert.deepEqual(d.stale, ['GET /gone']);
    assert.deepEqual(d.unaccounted, ['GET /none']);
    assert.deepEqual(d.openWithoutReason, ['GET /open']);
    const text = rc.describeDiff(d);
    assert.match(text, /GET \/a: recorded platform, now permission\[admin_x\]/);
    assert.match(text, /GET \/gone: in auth\/routes\.contract\.json but no longer mounted/);
});

test('a stronger class is never a finding', () => {
    assert.equal(rc.isWeaker({ gate: 'platform' }, { gate: 'auth' }), false);
    assert.equal(rc.isWeaker({ gate: 'permission', anyOf: ['a'] }, { gate: 'permission', anyOf: ['a', 'b'] }), false);
    assert.equal(rc.isWeaker({ gate: 'handler' }, { gate: 'handler' }), false);
});

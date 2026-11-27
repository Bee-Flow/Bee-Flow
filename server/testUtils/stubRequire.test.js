/**
 * Unit — testUtils/stubRequire (H2). DB-free, self-contained.
 * Run: node --test testUtils/stubRequire.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { installResolveStub, preloadStubs, evictModule } = require('./stubRequire');

test('installResolveStub redirects a require to the stub, restore() undoes it', () => {
    const restore = installResolveStub({ __fake_stub_pkg__: { hello: 42 } });
    try {
        assert.strictEqual(require('__fake_stub_pkg__').hello, 42, 'stub is served');
    } finally {
        restore();
    }
    assert.throws(
        () => require('__fake_stub_pkg__'),
        /Cannot find module/,
        'after restore the request is unresolvable again',
    );
});

test('restore() is idempotent', () => {
    const restore = installResolveStub({ __fake_stub_pkg2__: { v: 1 } });
    restore();
    assert.doesNotThrow(() => restore());
});

test('unstubbed requires still resolve normally while a stub is active', () => {
    const restore = installResolveStub({ __only_this__: { x: 1 } });
    try {
        // A real builtin must still load through the untouched resolver.
        assert.strictEqual(typeof require('node:path').join, 'function');
    } finally {
        restore();
    }
});

test('preloadStubs serves the stub under the real path, to any importer', () => {
    preloadStubs(require, { './mockDb': { stubbed: true } });
    try {
        assert.strictEqual(require('./mockDb').stubbed, true);
        assert.strictEqual(require('../testUtils/mockDb').stubbed, true, 'a different spelling of the same file');
    } finally {
        evictModule(require.resolve('./mockDb'));
    }
    assert.strictEqual(require('./mockDb').stubbed, undefined, 'the real module loads again once evicted');
});

// ── The stub follows a lookup by name ─────────────────────────────────────────
// Keys are require strings as written in the module under test, which sits beside its
// test: a key is resolved against the test's directory (testUtils/ here). When the tree
// path it names is a feature-module name (registered, or provided by a first-party
// module's firstParty/<id>.provides.json, also when that module is hidden), the stub is
// registered under that name too, whatever the name's top directory.
const { optionalFeatureModule, _featureModuleGetter, registerFeatureModules, _clearFeatureModulesForTests } = require('../core/featureModules');

test('a key naming a provided feature module is mirrored by name, and restore puts the previous getter back', () => {
    const previous = _featureModuleGetter('compliance/events');
    const double = { emit: () => 'double' };
    const restore = installResolveStub({ '../compliance/events': double });
    try {
        assert.strictEqual(optionalFeatureModule('compliance/events'), double, 'the lookup by name answers the stub');
    } finally {
        restore();
    }
    assert.strictEqual(_featureModuleGetter('compliance/events'), previous, 'the previous getter (or none) is back');
});

test('the key is resolved against the test directory: ./x names testUtils/x', () => {
    registerFeatureModules({ 'testUtils/__stubbedName__': () => ({ real: true }) });
    const double = { real: false };
    const restore = installResolveStub({ './__stubbedName__': double });
    try {
        assert.strictEqual(optionalFeatureModule('testUtils/__stubbedName__'), double);
    } finally {
        restore();
        assert.deepStrictEqual(optionalFeatureModule('testUtils/__stubbedName__'), { real: true });
        _clearFeatureModulesForTests('testUtils/__stubbedName__');
    }
});

test('a key copied from a deeper file names the tree path after its leading dots', () => {
    const double = { deeper: true };
    const restore = installResolveStub({ '../../../stores/complianceStore': double });
    try {
        assert.strictEqual(optionalFeatureModule('stores/complianceStore'), double);
    } finally {
        restore();
    }
});

test('a key that names no feature module is not registered by name', () => {
    const restore = installResolveStub({ '../db': { fake: true } });
    try {
        assert.strictEqual(_featureModuleGetter('db'), undefined);
        assert.strictEqual(_featureModuleGetter('testUtils/db'), undefined);
    } finally {
        restore();
    }
});

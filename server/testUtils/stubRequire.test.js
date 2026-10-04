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

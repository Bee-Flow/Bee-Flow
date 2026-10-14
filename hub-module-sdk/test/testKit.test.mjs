// Pins the shared module kit: test-kit/hostMock.js (the host mock every module
// test binds) and vite/moduleConfig.js (every module frontend's library build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    createHostMockFactory, makeDbMock, defaultIsPrivateTarget, silentLog, consoleLog,
} from '../test-kit/hostMock.js';
import { moduleViteConfig, HOST_PROVIDED_EXTERNALS } from '../vite/moduleConfig.js';

const sdk = join(dirname(fileURLToPath(import.meta.url)), '..');
const fakeExpress = () => {};

test('host mock: v2 surface with SDK defaults', async () => {
    const host = createHostMockFactory({ express: fakeExpress })();
    assert.deepEqual(Object.keys(host), [
        'hostApiVersion', 'db', 'express', 'middleware', 'stores', 'ai', 'usage', 'limits',
        'storage', 'webpages', 'net', 'log', 'isModuleActive', 'fetch',
    ]);
    assert.equal(host.hostApiVersion, 2);
    assert.equal(host.express, fakeExpress);
    assert.deepEqual(await host.limits.checkSubscription('o', 'a', 'u'), { allowed: true });
    assert.equal(host.log.info.toString(), consoleLog().info.toString());
    assert.equal(await host.isModuleActive('x'), true);
    assert.equal(await host.webpages.persist({}), 'webpage-mock-1');
    assert.equal(await host.webpages.persist({}), 'webpage-mock-2');
    assert.equal(await host.storage.getPresignedUrl('a b'), 'https://example.test/presigned/a%20b');
    assert.equal(await host.ai.resolveModelForTier({ model: 'm' }), 'm');
    await host.stores.configStore.setConfig('k', 1);
    assert.equal(await host.stores.configStore.getConfig('k'), 1);
    let called = false;
    host.middleware.requireCapability('x')({}, {}, () => { called = true; });
    assert.equal(called, true);
});

test('host mock: module defaults (moduleId, subscription, logger) and opts overrides', async () => {
    const make = createHostMockFactory({
        express: fakeExpress, moduleId: 'demo_mod', subscriptionResult: () => null, log: silentLog,
    });
    const host = make({ active: false });
    assert.equal(host.moduleId, 'demo_mod');
    assert.deepEqual(Object.keys(host).slice(0, 3), ['hostApiVersion', 'moduleId', 'db']);
    assert.equal(await host.limits.checkSubscription(), null);
    assert.equal(host.log.error('ignored'), undefined);
    assert.equal(await host.isModuleActive('demo_mod'), false);
    const db = {}; const log = {}; const net = {};
    const over = make({ db, log, net });
    assert.equal(over.db, db);
    assert.equal(over.log, log);
    assert.equal(over.net, net);
});

test('db mock: records calls, returns the seed, tx commits and rolls back', async () => {
    const db = makeDbMock({ one: { id: 1 }, all: [{ id: 2 }] });
    assert.deepEqual(await db.getOne('q', [1]), { id: 1 });
    assert.deepEqual(await db.getAll('q'), [{ id: 2 }]);
    assert.equal(await db.tx(async () => 'ok'), 'ok');
    await assert.rejects(db.tx(async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(db._calls.filter((c) => c.fn === 'query').map((c) => c.sql), ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);
});

test('defaultIsPrivateTarget blocks loopback, RFC1918 and non-http(s)', () => {
    for (const u of ['http://localhost/', 'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1', 'ftp://example.com', 'nope']) {
        assert.equal(defaultIsPrivateTarget(u), true, u);
    }
    for (const u of ['https://example.com', 'http://172.32.0.1']) assert.equal(defaultIsPrivateTarget(u), false, u);
});

test('a CommonJS module can require the kit (security_scan binds it)', async () => {
    const require = createRequire(join(sdk, 'modules/security_scan/test/'));
    const { makeHostMock } = require('./hostMock.js');
    const host = makeHostMock();
    assert.equal(host.moduleId, 'security_scan');
    assert.equal(await host.limits.checkSubscription(), null);
});

test('module vite config: library build with the react family external', () => {
    const plugin = { name: 'react' };
    const c = moduleViteConfig({ here: '/m/frontend', plugins: [plugin] });
    assert.deepEqual(c.plugins, [plugin]);
    assert.equal(c.build.outDir, '/m/frontend');
    assert.equal(c.build.emptyOutDir, false);
    assert.equal(c.build.cssCodeSplit, false);
    assert.equal(c.build.lib.entry, '/m/frontend/src/App.jsx');
    assert.deepEqual(c.build.lib.formats, ['es']);
    assert.equal(c.build.lib.fileName(), 'index.js');
    assert.deepEqual(c.build.rollupOptions.external, [
        'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
    ]);
    assert.deepEqual(c.build.rollupOptions.external, [...HOST_PROVIDED_EXTERNALS]);
    const names = c.build.rollupOptions.output.assetFileNames;
    assert.equal(names({ name: 'style.css' }), 'index.css');
    assert.equal(names({ name: 'logo.png' }), '[name][extname]');
    assert.equal(names({}), '[name][extname]');
});

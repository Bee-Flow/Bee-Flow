/**
 * browserProvider marks every "no browser to render with" failure with one
 * code, so a route can answer with a sanitized 503 instead of a 500 that
 * carried docker paths and env var names (services/browserProvider.js).
 *
 * Run: cd server && node --test services/browserProvider.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
delete process.env.BROWSER_ALLOW_LOCAL_LAUNCH;

const test = require('node:test');
const assert = require('node:assert');
const provider = require('./browserProvider');

const backend = { endpointError: null, connectError: null };
const DEPS = {
    pwtRunner: {
        getBrowserEndpoint: async () => {
            if (backend.endpointError) throw backend.endpointError;
            return 'ws://browser:9222/secret-path';
        },
    },
    chromium: () => ({
        connect: async () => {
            if (backend.connectError) throw backend.connectError;
            return {
                on() {},
                isConnected: () => true,
                newContext: async () => ({ close: async () => {} }),
            };
        },
    }),
};
test.after(() => provider.__setDepsForTests());

function freshProvider() {
    provider.__setDepsForTests(DEPS);
    return provider;
}

test.beforeEach(() => { backend.endpointError = null; backend.connectError = null; });

test('no Docker and no BROWSER_WS_ENDPOINT is a backend-unavailable error that names the sidecar', async () => {
    const provider = freshProvider();
    backend.endpointError = new Error('docker_unavailable: cannot start the shared browser container');
    await assert.rejects(provider.withContext({}, async () => 'never'), (err) => {
        assert.ok(provider.isBackendUnavailable(err));
        assert.strictEqual(err.code, provider.BACKEND_UNAVAILABLE);
        assert.match(err.message, /docker_unavailable/, 'the cause stays in the message for the log');
        assert.match(err.message, /BROWSER_WS_ENDPOINT/);
        assert.match(err.message, /server image has none/, 'BROWSER_ALLOW_LOCAL_LAUNCH is not offered as the fix');
        return true;
    });
});

test('a sidecar that is down (connect fails) is the same backend-unavailable error', async () => {
    const provider = freshProvider();
    backend.connectError = new Error('browserType.connect: connect ECONNREFUSED 172.20.0.5:9222');
    await assert.rejects(provider.withContext({}, async () => 'never'), (err) => provider.isBackendUnavailable(err));
});

test('a failure in the caller\'s own work is not mistaken for a missing backend', async () => {
    const provider = freshProvider();
    await assert.rejects(
        provider.withContext({}, async () => { throw new Error('page.pdf: Target closed'); }),
        (err) => !provider.isBackendUnavailable(err),
    );
});

test('a working backend renders', async () => {
    const provider = freshProvider();
    assert.strictEqual(await provider.withContext({}, async () => 'pdf'), 'pdf');
});

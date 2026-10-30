// @typecheck
'use strict';

/**
 * auth/lib/signingSecret.js — the durable-secret bootstrap retries when the
 * store does not answer, shares one bootstrap between concurrent callers, and
 * leaves env-set and already-durable secrets alone.
 *
 * Run: cd server && node --test auth/lib/signingSecret.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createSigningSecret } = require('./signingSecret');

const STORED = 'a'.repeat(96);
// Returns nothing on purpose: the module unrefs the timer it gets back, and an
// unref'd timer is all that would keep this test process alive.
const immediate = (/** @type {() => void} */ fn) => { setTimeout(fn, 0); };

/** @param {Partial<Parameters<typeof createSigningSecret>[0]>} [overrides] */
function make(overrides = {}) {
    return createSigningSecret({
        envVars: ['SIGNING_SECRET_TEST_UNSET'],
        devCacheName: 'beeflow-signing-secret-test',
        configKey: 'signing_secret_test',
        label: 'SigningSecretTest',
        productionWarning: 'not durable',
        productionLogLevel: 'warn',
        retryDelaysMs: [1, 1, 1],
        setTimer: immediate,
        ...overrides,
    });
}

/** @param {() => Promise<void>} fn */
async function inProduction(fn) {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await fn(); } finally { process.env.NODE_ENV = before; }
}

test('a store that times out twice is retried until the secret is durable', async () => {
    await inProduction(async () => {
        let calls = 0;
        const secret = make({
            setSecretIfAbsent: async () => {
                calls++;
                if (calls < 3) throw new Error('timeout exceeded when trying to connect');
                return STORED;
            },
        });
        const beforeBootstrap = secret.get();
        assert.strictEqual(secret.hasDurable(), false, 'random per-process secret until the bootstrap lands');

        assert.strictEqual(await secret.ensureDurable(), true);
        assert.strictEqual(calls, 3);
        assert.strictEqual(secret.hasDurable(), true);
        assert.strictEqual(secret.get().toString('utf8'), STORED);
        assert.notStrictEqual(secret.get(), beforeBootstrap, 'the stored secret replaces the random one');
    });
});

test('after the last retry the replica stays on its random secret and reports it', async () => {
    await inProduction(async () => {
        let calls = 0;
        const secret = make({
            retryDelaysMs: [1, 1],
            setSecretIfAbsent: async () => { calls++; throw new Error('no connection'); },
        });
        assert.strictEqual(await secret.ensureDurable(), false);
        assert.strictEqual(calls, 3, 'one attempt plus one per configured delay');
        assert.strictEqual(secret.hasDurable(), false);
    });
});

test('an unusable stored value is a configuration problem, not retried', async () => {
    await inProduction(async () => {
        let calls = 0;
        const secret = make({ setSecretIfAbsent: async () => { calls++; return 'short'; } });
        assert.strictEqual(await secret.ensureDurable(), false);
        assert.strictEqual(calls, 1);
    });
});

test('concurrent callers share one bootstrap; a durable secret is not bootstrapped again', async () => {
    await inProduction(async () => {
        let calls = 0;
        /** @type {(v: string) => void} */
        let release = () => {};
        const secret = make({
            setSecretIfAbsent: () => { calls++; return new Promise((resolve) => { release = resolve; }); },
        });
        const first = secret.ensureDurable();
        const second = secret.ensureDurable();
        release(STORED);
        assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
        assert.strictEqual(calls, 1);

        assert.strictEqual(await secret.ensureDurable(), true);
        assert.strictEqual(calls, 1, 'already durable: no store call');
    });
});

test('an env secret wins and the store is never asked', async () => {
    const name = 'SIGNING_SECRET_TEST_SET';
    process.env[name] = 'e'.repeat(40);
    try {
        let calls = 0;
        const secret = make({ envVars: [name], setSecretIfAbsent: async () => { calls++; return STORED; } });
        assert.strictEqual(await secret.ensureDurable(), true);
        assert.strictEqual(calls, 0);
        assert.strictEqual(secret.get().toString('utf8'), 'e'.repeat(40));
        assert.strictEqual(secret.hasDurable(), true);
    } finally {
        delete process.env[name];
    }
});

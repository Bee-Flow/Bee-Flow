'use strict';
/**
 * validateOutputForPii with no PII Guard installed: the reply passes unless an
 * operator set fail_closed, which asks for every reply to be screened.
 * Run: cd server && node --test core/privacy/piiDetection/validateOutput.noGuard.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
delete process.env.PII_SERVICE_URL;

const { makeSwaps } = require('../../../testUtils/swaps');

let AI_CONFIG = { piiDetectionEnabled: true };
const { swap, restore } = makeSwaps();
swap(require('../../aiAgent'), 'getAIConfig', async () => AI_CONFIG);
const configStore = require('../../../stores/configStore');
swap(configStore, 'getConfig', async () => null);
swap(configStore, 'getSecret', async () => '');
swap(configStore, 'getAllConfig', async () => ({}));
test.after(restore);

const { validateOutputForPii } = require('../piiDetection');

test('no guard and no failure mode: the reply passes, as before', async () => {
    AI_CONFIG = { piiDetectionEnabled: true };
    await validateOutputForPii(`Een antwoord ${Date.now()}`);
});

test('no guard under fail_closed: the reply is suppressed', async () => {
    AI_CONFIG = { piiDetectionEnabled: true, piiFailureMode: 'fail_closed' };
    await assert.rejects(() => validateOutputForPii(`Nog een antwoord ${Date.now()}`), (e) => e.privacyUnavailable === true && e.degradedReason === 'guard_not_installed');
});

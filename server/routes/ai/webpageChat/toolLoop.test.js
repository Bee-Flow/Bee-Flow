// @typecheck
/**
 * The termination log names the webpage (routes/ai/webpageChat/toolLoop.js).
 *
 * A webpage row carries `name`, not `title`; reading `title` labelled every
 * logged termination "Webpage chat".
 *
 * Run: cd server && node --test routes/ai/webpageChat/toolLoop.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const logged = [];
const restore = installResolveStub({
    '../../../stores/configStore': { async getConfig() { return null; } },
    '../../../stores/terminationStore': { async logTermination(row) { logged.push(row); } },
});
test.after(() => restore());

const { runToolLoop } = require('./toolLoop');

test('a stream error is logged under the webpage\'s name', async () => {
    const adapter = { async stream() { throw new Error('boom'); } };
    await runToolLoop({
        send: () => {}, req: {}, adapter, apiKey: 'k', apiUrl: 'u', modelId: 'm', messages: [],
        tiers: {}, resolvedTier: 'fast', clientSignal: undefined, isGone: () => false,
        webpage: { id: 'w1', name: 'Landing page' }, webpageId: 'w1', userId: 'u1', userOrgForTiers: 'o1',
        attachments: [], chatMode: 'auto', planExecution: false, kbIds: [], searchAvailable: false,
        framework: null, html: '', css: '', js: '', sources: [], modelSupportsVision: false,
        shieldGate: null, _dlpConvId: null, _dlpActive: false,
    });
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].termination_type, 'error');
    assert.strictEqual(logged[0].agent_name, 'Webpage: Landing page');
});

// @typecheck
/**
 * boot/ports — the hooks a lower layer declares are filled in at boot.
 *
 * Run: cd server && node --test boot/ports.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const seen = {};
installResolveStub({
    '../stores/agent/tokenDisplay': { setTokenMapReader(fn) { seen.reader = fn; } },
    '../core/dlp/dlpRunner': { getConversationTokenMapAsync: async () => ({ '[person_1]': 'Sem' }) },
    '../core/automationRunner/documentMarking': { setMarkingResolver(fn) { seen.marking = fn; } },
});
const { wirePorts } = require('./ports');

test('the token-map reader is always wired; marking comes from the compliance module, when wirePorts runs', async () => {
    assert.strictEqual(seen.marking, undefined, 'nothing is wired before wirePorts');
    // The flag is no longer read: the compliance module registers the resolver itself
    // (firstParty/compliance.register.js, channel boot/ports), and a module that is not
    // available does not register at all (core mode: BEEFLOW_HIDE_MODULES=all).
    wirePorts({ compliance: false });
    assert.deepStrictEqual(await seen.reader('c1'), { '[person_1]': 'Sem' });
    const compliance = require('../modules/firstParty/loader').modules().find((m) => m.id === 'compliance');
    assert.strictEqual(typeof seen.marking, compliance?.state === 'loaded' ? 'function' : 'undefined');
});

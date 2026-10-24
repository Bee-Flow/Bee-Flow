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

test('the token-map reader is always wired; marking only with compliance', async () => {
    wirePorts({ compliance: false });
    assert.deepStrictEqual(await seen.reader('c1'), { '[person_1]': 'Sem' });
    assert.strictEqual(seen.marking, undefined);
    wirePorts({ compliance: true });
    assert.strictEqual(typeof seen.marking, 'function');
});

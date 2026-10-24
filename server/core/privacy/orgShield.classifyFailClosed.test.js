'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const restore = installResolveStub({
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
    '../integrations/integrationToolMap': { resolveIntegration: () => { throw new Error('map unavailable'); } },
});
test.after(() => restore());

const { classifyToolClass } = require('./orgShield');

test('a tool that cannot be resolved is treated as external, so the outside-tools rules apply', () => {
    assert.strictEqual(classifyToolClass('gmail_send_email', {}), 'external');
});

test('built-in external tools stay external without the map', () => {
    assert.strictEqual(classifyToolClass('web_search', {}), 'external');
});

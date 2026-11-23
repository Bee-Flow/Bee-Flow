'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAiMeta } = require('./projectChatParsers');

test('an answer\'s stored meta keeps the documents it filled in from a template, as ids only', () => {
    const meta = parseAiMeta(JSON.stringify({ tier: 'fast', redacted: 0, categories: [], templateFills: ['doc-1', 42, '', 'doc-2'] }));
    assert.deepEqual(meta.templateFills, ['doc-1', 'doc-2']);
    assert.equal(parseAiMeta({ tier: 'fast' }).templateFills, undefined, 'absent when the answer filled in nothing');
});

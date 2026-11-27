// @typecheck
/**
 * The notebooks module's half of incognito.test.js: the tools an incognito turn withholds are
 * exactly the memory tools and the notebook tools (integrations/workspaceTools).
 *
 * Run: cd server && node --test core/conversation/incognito.notebooks.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { INCOGNITO_WITHHELD_TOOLS } = require('./incognito.mts');

test('the withheld list is exactly the memory tools and the notebook tools', () => {
    const { MEMORY_TOOLS } = require('../../integrations/memoryTools');
    const { WORKSPACE_TOOLS } = require('../../integrations/workspaceTools');
    const real = [...MEMORY_TOOLS, ...WORKSPACE_TOOLS].map((t) => t.function.name).sort();
    assert.deepStrictEqual([...INCOGNITO_WITHHELD_TOOLS].sort(), real, 'a memory or notebook tool was added or renamed: keep the list in step');
});

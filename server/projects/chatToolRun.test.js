// @typecheck
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { toolsPrompt } = require('./chatToolRun');

const offered = (...names) => names.map((name) => ({ type: 'function', function: { name } }));

test('BFSF-489: with the item tools the prompt says to look for an existing item first and change it, and no longer that it cannot', () => {
    const prompt = toolsPrompt(offered('create_document', 'create_notebook', 'list_project_items', 'read_project_item', 'edit_notebook'));
    assert.match(prompt, /Before you create a notebook or document, call list_project_items/);
    assert.match(prompt, /Change an existing notebook with edit_notebook/);
    assert.match(prompt, /copy find_text exactly/);
    assert.doesNotMatch(prompt, /cannot open, change/);
    assert.match(prompt, /cannot delete anything/);
});

test('the prompt speaks only of the tools that were offered', () => {
    const readOnly = toolsPrompt(offered('create_document', 'list_project_items', 'read_project_item'));
    assert.match(readOnly, /list_project_items/);
    assert.doesNotMatch(readOnly, /edit_notebook/, 'no notebook edits without the notebook tools');
    const searchOnly = toolsPrompt(offered('agent_search'));
    assert.doesNotMatch(searchOnly, /list_project_items|edit_notebook|create documents/);
});

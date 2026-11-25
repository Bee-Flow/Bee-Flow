// @typecheck
/**
 * The real tool lookups (./planLookups.mts) read the tool registry, the side-effect map and the open-web list. This
 * test also holds the plan test kit against them: the tool names the other plan tests use are real, with the app and
 * the effect the kit says they have.
 *
 * Run: cd server && node --test core/cowork/plan/planLookups.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// The app index asks for the tool registry by name: the registrations a booted server has (testUtils/stubRequire.js).
require('../../../boot/featureModules');

const { toolLookups } = require('./planLookups.mts');
const { fakeLookups } = require('./plan.testkit');

const real = toolLookups();

test('a tool belongs to its app, a built-in tool to none', () => {
    assert.strictEqual(real.appOfTool('gmail_search'), 'gmail');
    assert.strictEqual(real.appOfTool('outlook_read'), 'outlook');
    assert.strictEqual(real.appOfTool('no_such_tool_anywhere'), null);
});

test('effects are the side-effect map\'s: a read, a write, a send, and a write for a name nobody classified', () => {
    assert.strictEqual(real.effectOfTool('gmail_search'), 'reads');
    assert.strictEqual(real.effectOfTool('gmail_compose'), 'sends');
    assert.strictEqual(real.effectOfTool('gmail_create_draft'), 'writes');
    assert.strictEqual(real.effectOfTool('no_such_tool_anywhere'), 'writes');
});

test('reads on the open web are the ones a mail-started run is held to', () => {
    assert.strictEqual(real.isOpenWebRead('read_url'), true);
    assert.strictEqual(real.isOpenWebRead('agent_search'), true);
    assert.strictEqual(real.isOpenWebRead('gmail_search'), false);
});

test('the tool names the plan tests use are real, with the app and the effect the kit gives them', () => {
    const kit = fakeLookups();
    const names = ['outlook_search', 'outlook_read', 'outlook_create_draft', 'outlook_compose', 'outlook_reply_in_thread', 'gmail_read', 'drive_search', 'contacts_search', 'agent_search'];
    for (const name of names) {
        assert.strictEqual(real.appOfTool(name), kit.appOfTool(name), `app of ${name}`);
        assert.strictEqual(real.effectOfTool(name), kit.effectOfTool(name), `effect of ${name}`);
        assert.strictEqual(real.isOpenWebRead(name), kit.isOpenWebRead(name), `open web: ${name}`);
    }
});

test('a tool is called by its app and what the rest of its name says', () => {
    assert.strictEqual(real.labelOfTool?.('fireflies_list_transcripts'), 'Fireflies: list transcripts');
    assert.strictEqual(real.labelOfTool?.('gmail_search'), 'Gmail: search');
    assert.strictEqual(real.labelOfTool?.('no_such_tool_anywhere'), null);
});

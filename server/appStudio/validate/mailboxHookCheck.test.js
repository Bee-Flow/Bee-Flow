'use strict';

/** Run: cd server && node --test appStudio/validate/mailboxHookCheck.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkMailboxHooks } = require('./mailboxHookCheck');

const model = (onNewRecord) => ({ connectors: [
    { id: 'conn_a', kind: 'mailbox', onNewRecord },
    { id: 'conn_b', kind: 'rest', onNewRecord: { actionId: 'act_x', target: 'thread' } },
] });
const run = (dataModel, actions) => {
    const found = [];
    checkMailboxHooks(dataModel, actions, (f) => found.push(f));
    return found;
};

test('an allowed action, no hook and no data model all pass', () => {
    const actions = { act_a: { kind: 'sequence', steps: [{ kind: 'ai_generate' }, { kind: 'update_record' }] } };
    assert.deepEqual(run(model({ actionId: 'act_a', target: 'inbound_message' }), actions), []);
    assert.deepEqual(run(model(undefined), actions), []);
    assert.deepEqual(run(undefined, actions), []);
});

test('an action with send_email is an error that names the connector and the way out', () => {
    const actions = { act_a: { kind: 'sequence', steps: [{ kind: 'send_email' }] } };
    const found = run(model({ actionId: 'act_a', target: 'thread' }), actions);
    assert.equal(found.length, 1);
    assert.equal(found[0].code, 'mailbox_hook.action_invalid');
    assert.equal(found[0].severity, 'error');
    assert.match(found[0].message, /conn_a/);
    assert.match(found[0].message, /send_email/);
    assert.match(found[0].hint, /app_set_mailbox_hook/);
});

test('an action that does not exist is an error; only mailbox connectors count', () => {
    const found = run(model({ actionId: 'act_gone', target: 'inbound_message' }), {});
    assert.equal(found.length, 1);
    assert.match(found[0].message, /does not exist/);
});

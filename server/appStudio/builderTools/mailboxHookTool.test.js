'use strict';

/** Run: cd server && node --test appStudio/builderTools/mailboxHookTool.test.js */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// persistDataModel talks to the store; stand in for it before the tool loads.
const shared = require('./dataToolsShared');
let persisted;
shared.persistDataModel = async (draftWrap, nextModel) => { persisted = nextModel; draftWrap.dataModel = nextModel; draftWrap.dataModelVersion = 7; return { ok: true, version: 7, model: nextModel }; };

const { applySetMailboxHook } = require('./mailboxHookTool');
const { TOOL_SCHEMAS } = require('./schemas');

let wrap;
beforeEach(() => {
    persisted = null;
    wrap = {
        userId: 'u1', appId: 'app_1',
        def: { actions: {
            act_ok: { kind: 'sequence', steps: [{ kind: 'ai_generate', resultVar: 's' }, { kind: 'update_record' }] },
            act_mail: { kind: 'sequence', steps: [{ kind: 'send_email' }] },
        } },
        dataModel: { modelVersion: 1, tables: [], connectors: [
            { id: 'conn_aaaa', kind: 'mailbox', groupIntoThreads: true },
            { id: 'conn_bbbb', kind: 'rest' },
        ] },
    };
});

test('sets the hook on the mailbox connector and persists the model', async () => {
    const r = await applySetMailboxHook(wrap, { connectorId: 'conn_aaaa', actionId: 'act_ok', target: 'thread' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(persisted.connectors[0].onNewRecord, { actionId: 'act_ok', target: 'thread' });
    assert.equal(persisted.connectors[1].onNewRecord, undefined);
    assert.match(r.note, /next sync/);
});

test('actionId null switches it off', async () => {
    wrap.dataModel.connectors[0].onNewRecord = { actionId: 'act_ok', target: 'thread' };
    const r = await applySetMailboxHook(wrap, { connectorId: 'conn_aaaa', actionId: null });
    assert.equal(r.ok, true);
    assert.equal('onNewRecord' in persisted.connectors[0], false);
});

test('an action with send_email is refused with a way out, and nothing is saved', async () => {
    const r = await applySetMailboxHook(wrap, { connectorId: 'conn_aaaa', actionId: 'act_mail', target: 'thread' });
    assert.match(r.error, /send_email/);
    assert.match(r._fixHint, /Never send_email/);
    assert.equal(persisted, null);
});

test('unknown connector, REST connector, unknown action, bad target are refused with hints', async () => {
    const unknown = await applySetMailboxHook(wrap, { connectorId: 'conn_zzzz', actionId: 'act_ok', target: 'thread' });
    assert.match(unknown._fixHint, /conn_aaaa/);
    const rest = await applySetMailboxHook(wrap, { connectorId: 'conn_bbbb', actionId: 'act_ok', target: 'thread' });
    assert.match(rest.error, /Unknown mailbox connector/);
    const action = await applySetMailboxHook(wrap, { connectorId: 'conn_aaaa', actionId: 'act_nope', target: 'thread' });
    assert.match(action._fixHint, /app_set_action/);
    const target = await applySetMailboxHook(wrap, { connectorId: 'conn_aaaa', actionId: 'act_ok', target: 'both' });
    assert.match(target._fixHint, /thread.*inbound_message/);
    assert.equal(persisted, null);
});

test('target "thread" on a connector that does not group into threads is refused', async () => {
    delete wrap.dataModel.connectors[0].groupIntoThreads;
    const r = await applySetMailboxHook(wrap, { connectorId: 'conn_aaaa', actionId: 'act_ok', target: 'thread' });
    assert.match(r.error, /needs groupIntoThreads/);
});

test('the tool is advertised with its arguments', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_mailbox_hook');
    assert.ok(schema);
    assert.deepEqual(schema.function.parameters.required, ['connectorId', 'actionId']);
    assert.deepEqual(schema.function.parameters.properties.target.enum, ['thread', 'inbound_message']);
});

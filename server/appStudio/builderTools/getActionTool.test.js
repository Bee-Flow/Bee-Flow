/**
 * app_get_action: the stored definition of actions, whole, read-only, without secrets.
 *
 * Run: cd server && node --test appStudio/builderTools/getActionTool.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyGetAction, redactSecrets, MAX_GET_ACTIONS, REDACTED } = require('./getActionTool.mts');
const { applyToolCall, MUTATING_TOOLS, DATA_MODEL_TOOLS } = require('../builderTools');

const SEQUENCE = {
    kind: 'sequence',
    steps: [
        { kind: 'ai_generate', prompt: 'Summarise {{form.notes}} for the customer', outputSchema: { type: 'object', properties: { summary: { type: 'string' } } }, contextSources: [{ kind: 'table', tableId: 'tbl_aaa111' }] },
        {
            kind: 'switch',
            on: { kind: 'formula', expr: 'form.status' },
            cases: [
                { when: 'open', steps: [{ kind: 'toast', message: 'Open', tone: 'info' }] },
                { when: 'closed', steps: [{ kind: 'condition', if: { kind: 'formula', expr: 'true' }, then: [{ kind: 'update_record', tableId: 'tbl_aaa111', recordId: { kind: 'literal', value: 'rec_1' }, values: { status: { kind: 'literal', value: 'x' } } }] }] },
            ],
        },
    ],
};

const draft = (actions) => ({ userId: 'u1', def: { actions } });

test('returns the whole stored definition with every nested step intact', () => {
    const wrap = draft({ act_one000: SEQUENCE });
    const out = applyGetAction(wrap, { ids: ['act_one000'] });
    assert.deepEqual(out.actions.act_one000, SEQUENCE);
    assert.equal(out.redacted, undefined, 'nothing was redacted in an ordinary action');
    // A copy: editing the answer cannot touch the draft.
    out.actions.act_one000.steps.length = 0;
    assert.equal(wrap.def.actions.act_one000.steps.length, 2);
});

test('an unknown id is reported per id, the known ones are still answered', () => {
    const out = applyGetAction(draft({ act_one000: { kind: 'toast', message: 'hi' } }), { ids: ['act_one000', 'act_nope00', 'constructor'] });
    assert.ok(out.actions.act_one000);
    assert.deepEqual(out.unknownIds, ['act_nope00', 'constructor']);
    assert.equal(out.error, undefined);
});

test('refuses no ids and more than the cap', () => {
    assert.match(applyGetAction(draft({}), { ids: [] }).error, /ids is required/);
    assert.match(applyGetAction(draft({}), {}).error, /ids is required/);
    const many = Array.from({ length: MAX_GET_ACTIONS + 1 }, (_, i) => `act_${i}`);
    assert.match(applyGetAction(draft({}), { ids: many }).error, /at most 20/);
    const exactly = many.slice(0, MAX_GET_ACTIONS);
    assert.equal(applyGetAction(draft({}), { ids: exactly }).unknownIds.length, MAX_GET_ACTIONS);
});

test('secrets never leave: secret-named keys and URL credentials are redacted', () => {
    const action = {
        kind: 'sequence',
        steps: [
            { kind: 'open_url', url: 'https://user:hunter2@example.com/hook?token=abc123&page=2&api_key=zzz' },
            { kind: 'ai_generate', prompt: 'call https://example.com/x?access_token=SECRETVALUE now', headers: { Authorization: 'Bearer eyJhbGciOi', 'X-Trace': 'keep' } },
            { kind: 'set_variable', name: 'token', value: { kind: 'literal', value: 'plain' }, webhookSecret: 'whsec_123', clientSecret: 's3cr3t', credentialId: 'cred_1', password: '' },
        ],
    };
    const out = applyGetAction(draft({ act_sec0000: action }), { ids: ['act_sec0000'] });
    const text = JSON.stringify(out);
    for (const leaked of ['hunter2', 'abc123', 'zzz', 'SECRETVALUE', 'eyJhbGciOi', 'whsec_123', 's3cr3t', 'cred_1']) {
        assert.ok(!text.includes(leaked), `${leaked} must not appear in the answer`);
    }
    const [url, gen, vars] = out.actions.act_sec0000.steps;
    assert.match(url.url, /^https:\/\/example\.com\/hook\?/);
    assert.match(url.url, /page=2/, 'a harmless parameter survives');
    assert.equal(gen.headers.Authorization, REDACTED);
    assert.equal(gen.headers['X-Trace'], 'keep');
    assert.equal(vars.webhookSecret, REDACTED);
    assert.equal(vars.name, 'token', 'a VALUE that is the word token is not a secret');
    assert.equal(vars.password, '', 'an empty secret field has nothing to hide');
    assert.ok(out.redacted >= 6);
    assert.match(out.redactedNote, /placeholder/);
});

test('redactSecrets leaves plain text, numbers and nulls alone and is depth-bounded', () => {
    assert.deepEqual(redactSecrets({ a: 'x', b: 1, c: null, d: [true] }), { a: 'x', b: 1, c: null, d: [true] });
    let deep = { leaf: 1 };
    for (let i = 0; i < 100; i++) deep = { n: deep };
    assert.match(JSON.stringify(redactSecrets(deep)), /redacted/);
});

test('the tool is read-only and reachable through the dispatcher', async () => {
    assert.equal(MUTATING_TOOLS.has('app_get_action'), false);
    assert.equal(DATA_MODEL_TOOLS.has('app_get_action'), false);
    const wrap = draft({ act_one000: SEQUENCE });
    const before = JSON.stringify(wrap);
    const out = await applyToolCall('app_get_action', { ids: ['act_one000'] }, wrap);
    assert.deepEqual(out.actions.act_one000, SEQUENCE);
    assert.equal(JSON.stringify(wrap), before, 'the draft is untouched');
});

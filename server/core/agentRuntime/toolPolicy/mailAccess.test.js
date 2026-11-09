/**
 * `config.tools.<gmail|outlook>.mailAccess`: the preset resolves to actions, is validated on write, narrows the
 * unattended mail-triggered stack, and is the only thing that lets a reply in the thread run without a person.
 *
 * Run: node --test core/agentRuntime/toolPolicy/mailAccess.test.js
 * Uses the real tool registry, so the names are the ones the product ships.
 */

require('../../../boot/featureModules');
const { test } = require('node:test');
const assert = require('node:assert');

const { normaliseToolsConfig, isToolAllowed, confirmForTool, buildToolPolicy } = require('.');
const { narrowToolsForTurn } = require('../toolStackAssembly');
const { GMAIL_TOOLS } = require('../../../integrations/gmailTools');
const { OUTLOOK_TOOLS } = require('../../../integrations/outlookTools');
const { effectOf } = require('../../automationModel/sideEffectMap');

const names = (tools) => tools.map(t => t.function.name);
const norm = (tools) => normaliseToolsConfig({ tools }).tools;

for (const [appId, defs, draft, reply] of [
    ['gmail', GMAIL_TOOLS, 'gmail_create_draft', 'gmail_reply_in_thread'],
    ['outlook', OUTLOOK_TOOLS, 'outlook_create_draft', 'outlook_reply_in_thread'],
]) {
    const reads = names(defs).filter(n => effectOf(n) === 'reads');

    test(`${appId}: read = the reading tools only`, () => {
        const out = norm({ [appId]: { mailAccess: 'read' } });
        assert.deepStrictEqual([...out[appId].actions].sort(), [...reads].sort());
        assert.strictEqual(out[appId].mailAccess, 'read');
    });

    test(`${appId}: draft = read + create_draft`, () => {
        const out = norm({ [appId]: { mailAccess: 'draft' } });
        assert.deepStrictEqual([...out[appId].actions].sort(), [...reads, draft].sort());
    });

    test(`${appId}: send_reply = draft + reply in thread, and its stored confirm is ask`, () => {
        const out = norm({ [appId]: { mailAccess: 'send_reply', confirm: 'direct' } });
        assert.deepStrictEqual([...out[appId].actions].sort(), [...reads, draft, reply].sort());
        assert.strictEqual(out[appId].confirm, 'ask');
        assert.ok(!out[appId].actions.includes(`${appId}_compose`));
    });

    test(`${appId}: mailAccess wins over a hand-picked list; without it actions keep working`, () => {
        const out = norm({ [appId]: { mailAccess: 'read', actions: [`${appId}_compose`] } });
        assert.ok(!out[appId].actions.includes(`${appId}_compose`));
        const plain = norm({ [appId]: { actions: [`${appId}_compose`] } });
        assert.deepStrictEqual(plain[appId].actions, [`${appId}_compose`]);
        assert.strictEqual(plain[appId].mailAccess, undefined);
    });

    test(`${appId}: isToolAllowed follows the preset, also on a config that was never normalised`, () => {
        const raw = { [appId]: { mailAccess: 'draft' } };
        assert.strictEqual(isToolAllowed(draft, raw), true);
        assert.strictEqual(isToolAllowed(reply, raw), false);
        assert.strictEqual(isToolAllowed(`${appId}_compose`, raw), false);
    });
}

test('an unreadable level is the narrow one, said out loud; a non-mail app drops it', () => {
    const r = normaliseToolsConfig({ tools: { gmail: { mailAccess: 'everything' }, 'google-drive': { mailAccess: 'read' } } });
    assert.strictEqual(r.tools.gmail.mailAccess, 'read');
    assert.ok(!r.tools.gmail.actions.includes('gmail_create_draft'));
    assert.strictEqual(r.tools['google-drive'].mailAccess, undefined);
    assert.ok(r.warnings.some(w => /mailAccess must be/.test(w)));
    assert.ok(r.warnings.some(w => /only applies to Gmail and Outlook/.test(w)));
});

test('a reply in the thread is direct ONLY for send_reply in a mail-triggered run', () => {
    const cfg = norm({ gmail: { mailAccess: 'send_reply' } });
    assert.strictEqual(confirmForTool('gmail_reply_in_thread', cfg), 'ask');
    assert.strictEqual(confirmForTool('gmail_reply_in_thread', cfg, { mailTrigger: true }), 'direct');
    const draftOnly = norm({ gmail: { mailAccess: 'draft' } });
    assert.strictEqual(confirmForTool('gmail_reply_in_thread', draftOnly, { mailTrigger: true }), 'ask');
    // Other sends stay ask, trigger or not.
    assert.strictEqual(confirmForTool('gmail_compose', cfg, { mailTrigger: true }), 'ask');
    assert.strictEqual(confirmForTool('outlook_compose', norm({ outlook: { mailAccess: 'send_reply' } }), { mailTrigger: true }), 'ask');
});

const agentWith = (tools) => ({ config: { tools }, id: 'a1' });
const stack = () => [...GMAIL_TOOLS, ...OUTLOOK_TOOLS];
const mailRun = { unattended: true, mailTrigger: { provider: 'gmail', messageId: 'm1', threadId: 't1' } };

test('mail-triggered, no mailAccess: reads only, no draft, no send, no compose, no forward', () => {
    const { tools } = narrowToolsForTurn({ tools: stack(), agent: agentWith({ gmail: { actions: '*' } }), agentId: 'a1', messageMetadata: mailRun });
    const got = names(tools);
    for (const n of got.filter(x => /^(gmail|outlook)_/.test(x))) assert.strictEqual(effectOf(n), 'reads', `${n} should not be offered`);
    assert.ok(got.includes('gmail_read') && got.includes('outlook_read'));
    assert.ok(!got.some(n => /_compose$|forward|create_draft|reply_in_thread/.test(n)));
});

test('mail-triggered with mailAccess: draft adds only the draft tool, send_reply adds the reply tool, compose never', () => {
    const draft = names(narrowToolsForTurn({ tools: stack(), agent: agentWith({ gmail: { mailAccess: 'draft' } }), agentId: 'a1', messageMetadata: mailRun }).tools);
    assert.ok(draft.includes('gmail_create_draft'));
    assert.ok(!draft.includes('gmail_reply_in_thread') && !draft.includes('gmail_compose'));
    assert.ok(!draft.includes('outlook_create_draft'), 'the other app has no mailAccess: reads only');
    const send = names(narrowToolsForTurn({ tools: stack(), agent: agentWith({ gmail: { mailAccess: 'send_reply' } }), agentId: 'a1', messageMetadata: mailRun }).tools);
    assert.ok(send.includes('gmail_reply_in_thread') && send.includes('gmail_create_draft'));
    assert.ok(!send.includes('gmail_compose'));
});

test('mail-triggered, uncurated agent: every other app\'s send is dropped too, reads and writes stay', () => {
    const fn = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
    const others = ['nextcloud_mail_send', 'nextcloud_talk_send_message', 'nextcloud_share_by_email', 'nextcloud_list_files', 'nextcloud_create_folder'];
    assert.strictEqual(effectOf('nextcloud_mail_send'), 'sends');
    assert.strictEqual(effectOf('nextcloud_list_files'), 'reads');
    const got = names(narrowToolsForTurn({ tools: [...stack(), ...others.map(fn)], agent: { config: null, id: 'a1' }, agentId: 'a1', messageMetadata: mailRun }).tools);
    for (const n of others) {
        if (effectOf(n) === 'sends') assert.ok(!got.includes(n), `${n} must not be offered in a mail-triggered run`);
        else assert.ok(got.includes(n), `${n} should stay`);
    }
    assert.ok(!got.includes('gmail_compose') && !got.includes('outlook_compose'));
});

test('an ordinary unattended run is unchanged, except that the reply tool exists only for mail-triggered runs', () => {
    const before = names(stack());
    const got = names(narrowToolsForTurn({ tools: stack(), agent: { config: null, id: 'a1' }, agentId: 'a1', messageMetadata: { autoSend: true } }).tools);
    assert.ok(got.includes('gmail_compose') && got.includes('outlook_compose'));
    assert.deepStrictEqual(before.filter(n => !/reply_in_thread/.test(n)), got);
});

test('buildToolPolicy: the reply tool is not gated in a mail-triggered run with send_reply, and survives the unattended drop', () => {
    const cfg = { tools: norm({ gmail: { mailAccess: 'send_reply' } }) };
    const tools = GMAIL_TOOLS.filter(t => /reply_in_thread|^gmail_read$/.test(t.function.name));
    const withTrigger = buildToolPolicy({ agentConfig: cfg, tools, unattended: true, mailTrigger: true });
    assert.ok(withTrigger.allowedToolNames.has('gmail_reply_in_thread'));
    assert.deepStrictEqual(withTrigger.droppedForUnattended, []);
    const without = buildToolPolicy({ agentConfig: cfg, tools, unattended: true });
    assert.deepStrictEqual(without.droppedForUnattended, ['gmail_reply_in_thread']);
});

/**
 * A run started by a received e-mail gets an allow-list: the mail tools per `mailAccess`, reads that stay inside
 * Bee Flow or the owner's connected apps, and other tools only for an app the owner switched on for these runs
 * (never one that asks first). The run remembers when it used anything outside the triggering thread.
 *
 * Run: node --test core/agentRuntime/toolPolicy/mailRun.test.js
 * Uses the real tool registry, so the names are the ones the product ships.
 */

require('../../../boot/featureModules');
const { test } = require('node:test');
const assert = require('node:assert');

const { normaliseToolsConfig, buildToolPolicy, decideToolCall } = require('.');
const { narrowToolsForTurn } = require('../toolStackAssembly');
const { keepInMailRun, noteMailRunToolUse, appOptedInForMailRuns, replyAllAllowed } = require('./mailRun.mts');
const { appIdForTool } = require('./appIndex');
const { GMAIL_TOOLS } = require('../../../integrations/gmailTools');

const fn = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const names = (tools) => tools.map(t => t.function.name);
const mailRun = () => ({ unattended: true, autoSend: true, mailTrigger: { provider: 'gmail', messageId: 'm1', threadId: 't1' } });
const narrow = (toolNames, tools) => names(narrowToolsForTurn({
    tools: [...GMAIL_TOOLS, ...toolNames.map(fn)], agent: { config: tools ? { tools } : null, id: 'a1' }, agentId: 'a1', messageMetadata: mailRun(),
}).tools);

test('an uncurated agent: open-web reads, shares, the browser and writes are not in the stack; inside reads are', () => {
    const got = narrow([
        'read_url', 'agent_search', 'browse_web', 'nextcloud_create_share', 'nextcloud_delete', 'nextcloud_direct_link',
        'frappe_crm_update_deal', 'webpage_file_write', 'n8n_workflow_execute', 'set_reminder', 'set_ai_task',
        'kb_search', 'kb_fetch', 'datatable_query', 'nextcloud_list_files', 'activate_skill',
    ], null);
    for (const n of ['read_url', 'agent_search', 'browse_web', 'nextcloud_create_share', 'nextcloud_delete', 'nextcloud_direct_link',
        'frappe_crm_update_deal', 'webpage_file_write', 'n8n_workflow_execute', 'set_reminder', 'set_ai_task',
        'gmail_compose', 'gmail_create_draft', 'gmail_reply_in_thread', 'gmail_trash']) {
        assert.ok(!got.includes(n), `${n} must not be offered in a mail-started run`);
    }
    for (const n of ['kb_search', 'kb_fetch', 'datatable_query', 'nextcloud_list_files', 'activate_skill', 'gmail_search', 'gmail_read']) {
        assert.ok(got.includes(n), `${n} should stay`);
    }
});

test('an app the owner switched on for mail runs: its direct tools stay, its tools that ask do not', () => {
    const nextcloud = appIdForTool('nextcloud_create_folder');
    assert.ok(nextcloud, 'the registry names the app');
    const direct = normaliseToolsConfig({ tools: { [nextcloud]: { actions: '*', confirm: 'direct', mailRuns: true } } }).tools;
    const got = narrow(['nextcloud_create_folder', 'nextcloud_share_by_email', 'read_url'], direct);
    assert.ok(got.includes('nextcloud_create_folder'));
    assert.ok(!got.includes('nextcloud_share_by_email'), 'a send always asks, so it is dropped');
    assert.ok(!got.includes('read_url'), 'another app is not switched on');
    const asks = normaliseToolsConfig({ tools: { [nextcloud]: { actions: '*', confirm: 'ask', mailRuns: true } } }).tools;
    assert.ok(!narrow(['nextcloud_create_folder'], asks).includes('nextcloud_create_folder'));
    const notOn = normaliseToolsConfig({ tools: { [nextcloud]: { actions: '*', confirm: 'direct' } } }).tools;
    assert.ok(!narrow(['nextcloud_create_folder'], notOn).includes('nextcloud_create_folder'));
});

test('keepInMailRun: a granted automation and a reply tool of an unknown app are not kept', () => {
    assert.strictEqual(keepInMailRun({ name: 'run_my_flow', appId: null, toolsConfig: null, asks: false, isAutomation: true }), false);
    assert.strictEqual(keepInMailRun({ name: 'gmail_reply_in_thread', appId: null, toolsConfig: null, asks: false }), false);
    assert.strictEqual(keepInMailRun({ name: 'kb_search', appId: null, toolsConfig: null, asks: false }), true);
});

test('normalisation keeps mailRuns on other apps and replyAll on mail apps, only as true', () => {
    const r = normaliseToolsConfig({ tools: {
        'google-drive': { actions: '*', mailRuns: true, replyAll: true },
        gmail: { mailAccess: 'send_reply', replyAll: true, mailRuns: true },
        outlook: { mailAccess: 'read', replyAll: 'yes' },
    } });
    assert.strictEqual(r.tools['google-drive'].mailRuns, true);
    assert.strictEqual(r.tools['google-drive'].replyAll, undefined);
    assert.strictEqual(r.tools.gmail.replyAll, true);
    assert.strictEqual(r.tools.gmail.mailRuns, undefined);
    assert.strictEqual(r.tools.outlook.replyAll, undefined);
    assert.ok(r.warnings.some(w => /replyAll must be true or false/.test(w)));
    assert.strictEqual(appOptedInForMailRuns(r.tools, 'google-drive'), true);
    assert.strictEqual(replyAllAllowed(r.tools, 'gmail'), true);
    assert.strictEqual(replyAllAllowed(r.tools, 'outlook'), false);
    assert.strictEqual(replyAllAllowed(r.tools, 'google-drive'), false);
});

test('the round policy of a mail-started run refuses a name outside the stack, also for an uncurated agent', () => {
    const policy = buildToolPolicy({ agentConfig: null, tools: [fn('kb_search')], unattended: true, mailTrigger: true });
    assert.strictEqual(decideToolCall({ toolName: 'read_url', policy }).action, 'refuse');
    assert.strictEqual(decideToolCall({ toolName: 'kb_search', policy }).action, 'run');
    const chat = buildToolPolicy({ agentConfig: null, tools: [fn('kb_search')], unattended: true });
    assert.strictEqual(decideToolCall({ toolName: 'read_url', policy: chat }).action, 'run', 'other runs keep their behaviour');
});

test('noteMailRunToolUse: reading the triggering thread keeps the run inside it; anything else marks it', () => {
    const mt = { messageId: 'm1', threadId: 't1' };
    noteMailRunToolUse(mt, 'gmail_read', { messageId: 'm1' }, { id: 'm1', threadId: 't1' });
    noteMailRunToolUse(mt, 'outlook_read', { messageId: 'x' }, JSON.stringify({ conversationId: 't1' }));
    noteMailRunToolUse(mt, 'gmail_read_attachment', { messageId: 'm1', attachmentId: 'a' }, {});
    noteMailRunToolUse(mt, 'activate_skill', {}, 'Loaded');
    noteMailRunToolUse(mt, 'gmail_create_draft', {}, {});
    assert.strictEqual(mt.readOutside, undefined);
    noteMailRunToolUse(mt, 'gmail_read', { messageId: 'm7' }, { id: 'm7', threadId: 'other' });
    assert.strictEqual(mt.readOutside, true);

    for (const [name, args, value] of [['kb_search', { query: 'x' }, {}], ['gmail_search', {}, {}], ['gmail_read', { messageId: 'm1' }, null]]) {
        const fresh = { messageId: 'm1', threadId: 't1' };
        noteMailRunToolUse(fresh, name, args, value);
        assert.strictEqual(fresh.readOutside, true, name);
    }
    assert.doesNotThrow(() => noteMailRunToolUse(null, 'kb_search', {}, {}));
});

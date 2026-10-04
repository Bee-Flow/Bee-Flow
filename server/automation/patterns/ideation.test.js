'use strict';

/**
 * Ideas mode: the model-led scan, moved out of the route. What it pins: the
 * apps it may read, the breadth-first and budget rules of its reads, the
 * Shield on the reads and on the prompt, the user-only activity digest, and
 * the cached ideas suppressed by the user's titles. A stub model drives the
 * tool loop; no module mocking.
 *
 * Run: cd server && node --test automation/patterns/ideation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { runIdeasScan, suppressIdeas, integrationOf, SUGGEST_MAX_READS_PER_INTEGRATION } = require('./ideation');

const tool = (name) => ({ type: 'function', function: { name } });
const resolveIntegration = (name) => ({ integration: name.split('_')[0] });

function setup({ calls = [], guardAiInput = async () => ({ blocked: false }), guardToolOutput = async (out) => ({ result: out, categories: [] }) } = {}) {
    const fx = { sent: [], reads: [], activity: [], loopMessages: null, forced: [] };
    const deps = {
        resolveIntegration,
        isSideEffect: (n) => /_(send|upload|append)/.test(n),
        getIntegrationByTool: async (f) => { fx.activity.push(f); return [{ tool_name: 'gmail_search', integration_type: 'gmail', total: 9, last_used: new Date() }]; },
        getAutomations: async () => [{ title: 'Invoice mail to sheet' }],
        getRecentSuppressedTitles: async () => ['Weekly digest'],
        guardAiInput,
        guardToolOutput,
        llmClient: {
            async chatForcedTool(modelId, messages, toolDef, opts) {
                fx.forced.push({ messages, opts });
                return { structured: { suggestions: [{ title: 'Tidy the inbox', buildPrompt: 'Label new mail.', requiredIntegrations: ['gmail'] }] } };
            },
            async runToolLoop(modelId, messages, tools, opts, execute) {
                fx.loopMessages = messages;
                fx.loopOpts = opts;
                fx.toolOuts = [];
                for (const name of calls) fx.toolOuts.push(await execute(name, { q: 'x' }));
                return { toolCallRounds: 2, structured: { suggestions: [] }, usage: { prompt_tokens: 5 } };
            },
        },
    };
    const reader = {
        read: async (name) => { fx.reads.push(name); return { ok: true, value: { items: [`result of ${name}`] } }; },
        gate: { forModel: async (c) => c },
    };
    const input = (over = {}) => ({
        userId: 'u1', orgId: 'org-1', integrationIds: [], focus: '', modelId: 'fast',
        tools: [tool('gmail_search'), tool('gmail_read'), tool('drive_list_files'), tool('gmail_send')],
        availableIntegrationIds: new Set(['gmail', 'drive']),
        policy: {}, auditBase: {}, guardCtx: {}, reader, send: (e, d) => fx.sent.push([e, d]),
        ...over,
    });
    return { fx, deps, input };
}

test('the picked apps narrow the read-only tools; an app the user lacks means no_integrations', async () => {
    const { fx, deps, input } = setup({ calls: [] });
    await runIdeasScan(input({ integrationIds: ['gmail'] }), deps);
    assert.match(fx.loopMessages[0].content, /tools for these integrations: gmail\./);

    const none = await runIdeasScan(input({ integrationIds: ['slack'] }), deps);
    assert.strictEqual(none.reason, 'no_integrations');
    assert.deepStrictEqual(none.suggestions, []);
});

test('only write tools: one forced synthesis call with the documented options and the scan\'s signal', async () => {
    const { fx, deps, input } = setup();
    const ac = new AbortController();
    const out = await runIdeasScan(input({ tools: [tool('gmail_send')], signal: ac.signal }), deps);
    assert.strictEqual(fx.forced.length, 1);
    const { opts } = fx.forced[0];
    assert.deepStrictEqual([opts.maxTokens, opts.temperature, opts.reasoningEffort, opts.signal], [4096, 0.2, 'none', ac.signal]);
    assert.strictEqual(out.suggestions[0].title, 'Tidy the inbox');
    assert.deepStrictEqual(fx.sent.filter(([e]) => e === 'phase').map(([, d]) => d.phase), ['scanning', 'synthesising']);
});

test('reads go breadth first, at most a few per app, and every one through the reader', async () => {
    const calls = ['gmail_search', 'gmail_read', 'drive_list_files', ...Array(6).fill('gmail_search')];
    const { fx, deps, input } = setup({ calls });
    const out = await runIdeasScan(input(), deps);
    assert.match(fx.toolOuts[1], /already looked at gmail.*drive/, 'a second gmail read waits for drive');
    assert.deepStrictEqual(fx.reads.slice(0, 2), ['gmail_search', 'drive_list_files']);
    assert.strictEqual(fx.reads.filter((r) => r.startsWith('gmail')).length, SUGGEST_MAX_READS_PER_INTEGRATION);
    assert.match(fx.toolOuts.at(-1), /sampled gmail enough/);
    assert.strictEqual(out.summary.toolCalls, fx.reads.length);
    assert.deepStrictEqual(out.summary.integrations.sort(), ['drive', 'gmail']);
    assert.ok(fx.sent.some(([e, d]) => e === 'scan_step' && d.phase === 'start' && d.tool === 'drive_list_files'));
    assert.strictEqual(fx.loopOpts.reasoningEffort, 'none');
});

test('a read whose output the Shield blocks reaches the model as a withheld line', async () => {
    const guardToolOutput = async () => { throw Object.assign(new Error('blocked'), { categories: ['Email'] }); };
    const { fx, deps, input } = setup({ calls: ['gmail_search'], guardToolOutput });
    const out = await runIdeasScan(input(), deps);
    assert.strictEqual(fx.toolOuts[0], '[withheld: contains sensitive data (Email)]');
    const done = fx.sent.find(([e, d]) => e === 'scan_step' && d.phase === 'done')[1];
    assert.deepStrictEqual([done.ok, done.piiCategories], [false, ['Email']]);
    assert.deepStrictEqual(out.summary.piiCategories, ['Email']);
});

test('a prompt the Shield blocks is sent without the focus and the titles', async () => {
    const { fx, deps, input } = setup({ calls: [], guardAiInput: async () => ({ blocked: true, categories: ['Person'] }) });
    const out = await runIdeasScan(input({ focus: 'mail from Pieter Bakker' }), deps);
    assert.ok(!fx.loopMessages[0].content.includes('Pieter'));
    assert.ok(!fx.loopMessages[0].content.includes('Invoice mail to sheet'));
    assert.deepStrictEqual(out.summary.piiCategories, ['Person']);
});

test('the activity digest is the user\'s own tool calls, never the organisation\'s', async () => {
    const { fx, deps, input } = setup({ calls: [] });
    await runIdeasScan(input(), deps);
    assert.strictEqual(fx.activity.length, 1);
    assert.strictEqual(fx.activity[0].userId, 'u1');
    assert.ok(!('organizationId' in fx.activity[0]));
    assert.strictEqual(fx.activity[0].excludeDryRun, true);
    // Chat-initiated calls only: an earlier scan's own pattern_scan reads and
    // an automation's calls are not the user's work.
    assert.strictEqual(fx.activity[0].manualOnly, true);
    assert.match(fx.loopMessages[1].content, /gmail_search/);
});

test('an idea keeps no e-mail address, link or host: not in the stream, not in the cache', async () => {
    const { deps, input } = setup({ calls: [] });
    deps.llmClient.chatForcedTool = async () => ({ structured: { suggestions: [{
        title: 'Answer billing@acme-supplies.example',
        description: 'Mail from pieter@acme-supplies.example lands weekly',
        buildPrompt: 'When mail from pieter@acme-supplies.example arrives, save https://portal.acme.example/x to acme-supplies.nl.',
        requiredIntegrations: ['gmail'],
    }] } });
    const out = await runIdeasScan(input({ tools: [] }), deps);
    assert.strictEqual(out.suggestions.length, 1);
    const s = out.suggestions[0];
    assert.strictEqual(s.title, 'Answer an email address');
    assert.strictEqual(s.buildPrompt, 'When mail from an email address arrives, save a link to a website.');
    assert.doesNotMatch(JSON.stringify(out.suggestions), /@|acme|https?:/);
});

test('cached ideas the user has since automated or dismissed are dropped', async () => {
    const { deps } = setup();
    const kept = await suppressIdeas([
        { title: 'Invoice mail into a sheet' }, { title: 'Weekly digest' }, { title: 'Tidy the inbox' },
    ], { userId: 'u1' }, deps);
    assert.deepStrictEqual(kept.map((s) => s.title), ['Tidy the inbox']);
});

test('a tool\'s integration comes from the tool map, else its prefix', () => {
    assert.strictEqual(integrationOf(() => ({ integration: 'Google_Drive' }), 'drive_list_files'), 'google_drive');
    assert.strictEqual(integrationOf(() => null, 'slack_post_message'), 'slack');
    assert.strictEqual(integrationOf(() => { throw new Error('x'); }, 'notion_search'), 'notion');
});

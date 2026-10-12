/**
 * contextBuilder — prompt-cache split.
 *
 * `buildSystemPrompt` returns two halves. The `stable` half becomes system[0],
 * the block the Claude adapter puts a 1-hour cache_control breakpoint on, so it
 * must be byte-identical across the turns of a conversation. The regression
 * this guards: a second-resolution `Now:` line and relevance-retrieved memories
 * were concatenated into that half, making every agent request a cache miss.
 *
 * Run: node --test core/agentRuntime/contextBuilder.test.js
 *
 * The DB-backed dependencies (tool hints, skills, house style) are mocked
 * through the require cache — same pattern as core/imageInline.test.js — so
 * this stays a pure prompt-shaping test with no Postgres.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-session-secret-0123456789abcdef';

function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock('../integrations/integrationTools', { buildToolHint: async () => '\n\n[TOOLS]\nweb search available.' });
mock('../tools/skillInjection', {
    buildSkillInjection: async () => ({
        systemPromptAddendum: '', staticCount: 0, dynamicSkillIds: [], tools: [],
    }),
});
mock('../../stores/houseStyleStore', { getDefaultForOrg: async () => null });
// The open-document block reads through the store (readable for u1 only).
mock('../../stores/documentStore', {
    getDocument: async (id, userId) => (id === 'doc1' && userId === 'u1'
        ? { id: 'doc1', name: 'Offerte', docType: 'quote', bodyHtml: '<h1>Titel</h1><p>Inhoud <b>hier</b></p>' }
        : null),
});

const { buildSystemPrompt } = require('./contextBuilder');
const { systemPrefixFingerprint } = require('../llm/promptCacheStability');

const AGENT = { system_prompt: 'You are Bee Flow. It is {DateTime}.' };

const build = (over = {}) => buildSystemPrompt({
    agent: AGENT,
    tools: [],
    userId: 'u1',
    messageMetadata: { timezone: 'UTC' },
    memoryContext: '',
    isStrictKnowledge: false,
    ...over,
});

test('the stable half carries no clock', async () => {
    const { stable, volatile } = await build();

    assert.ok(!/\bNow:\s*\d/.test(stable), 'the Now: line must not reach the cached half');
    assert.ok(!/{DateTime}|{Time}/.test(stable), 'clock tags are consumed, not left literal');
    assert.match(volatile, /Now: \d{4}-\d{2}-\d{2}/, 'the timestamp rides the volatile half');
});

test('the stable half is byte-identical across turns that differ in memory and clock', async () => {
    const turn1 = await build({ memoryContext: '[MEMORY]\nUser prefers Dutch.' });
    const turn2 = await build({ memoryContext: '[MEMORY]\nUser is based in Utrecht.' });

    assert.strictEqual(
        systemPrefixFingerprint(turn1.stable),
        systemPrefixFingerprint(turn2.stable),
        'retrieved memory must not move the cached prefix',
    );
    assert.notStrictEqual(turn1.volatile, turn2.volatile, 'the volatile half is expected to differ');
    assert.ok(turn1.volatile.includes('prefers Dutch'));
    assert.ok(!turn1.stable.includes('prefers Dutch'), 'memory must not leak into the cached half');
});

test('the tool hint stays in the cached half', async () => {
    const { stable } = await build();
    assert.ok(stable.includes('[TOOLS]'), 'tool hints are stable per conversation and should be cached');
});

test('per-turn notebook selection stays out of the cached half', async () => {
    const meta = { timezone: 'UTC', notebookspaceContent: '' };
    const base = await build({ messageMetadata: meta });
    const withSel = await build({
        messageMetadata: { ...meta, notebookspaceSelection: 'the third paragraph' },
    });

    assert.strictEqual(base.stable, withSel.stable, 'a selection change must not move the cached prefix');
    assert.ok(withSel.volatile.includes('the third paragraph'));
    assert.ok(base.stable.includes('[NOTEBOOK OPEN]'), 'the static notebook rules stay cached');
});

test('strict-knowledge mode still prepends its constraint to the cached half', async () => {
    const { stable } = await build({ isStrictKnowledge: true });
    assert.match(stable, /^⚠️ CRITICAL OPERATIONAL CONSTRAINT/);
});

test('agent chat carries the reply-language rule in the cached half, whatever the agent prompt says (BFSF-387)', async () => {
    const { stable } = await build({ memoryContext: '[MEMORY]\n- language: Dutch' });
    assert.match(stable, /## Reply language/);
    assert.match(stable, /Active Memory never overrides the language of the user's latest message/);
});

test('an open side-panel document is injected read-only, as plain text, in the volatile half', async () => {
    const { stable, volatile } = await build({ messageMetadata: { timezone: 'UTC', sidePanelDocument: { id: 'doc1', name: 'client hint' } } });
    assert.match(volatile, /\[DOCUMENT OPEN: Offerte\]/);
    assert.match(volatile, /Titel\nInhoud hier/);
    assert.ok(!volatile.includes('<h1>'));
    assert.ok(!stable.includes('DOCUMENT OPEN'), 'never in the cached half');
});

test('no document block without sidePanelDocument, for an unreadable one, or a malformed one', async () => {
    for (const meta of [{}, { sidePanelDocument: { id: 'nope' } }, { sidePanelDocument: { id: 7 } }, { sidePanelDocument: 'doc1' }]) {
        const { stable, volatile } = await build({ messageMetadata: { timezone: 'UTC', ...meta } });
        assert.ok(!stable.includes('DOCUMENT OPEN') && !volatile.includes('DOCUMENT OPEN'), JSON.stringify(meta));
    }
    const other = await build({ userId: 'u2', messageMetadata: { timezone: 'UTC', sidePanelDocument: { id: 'doc1' } } });
    assert.ok(!other.volatile.includes('DOCUMENT OPEN'), 'another user cannot read it');
});

/**
 * The ledger row of a surface call: an explicit field list, zero tokens when
 * the provider reported none, and a sink failure that never escapes.
 *
 * Run: cd server && node --test core/llm/surfaceUsage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { logSurfaceUsage, surfaceUsageEntry } = require('./surfaceUsage');
const { SOURCES, areaOf } = require('../../shared/usageAreas');

test('the entry carries the person, the org, the source, the model and the tokens', () => {
    const e = surfaceUsageEntry({
        source: 'chat_title', userId: 'u1', orgId: 'org-1', model: 'm', usage: { prompt_tokens: 7, completion_tokens: 3 },
        startedAt: Date.now() - 5, conversationId: 'c1',
    });
    assert.strictEqual(e.user_id, 'u1');
    assert.strictEqual(e.organization_id, 'org-1');
    assert.strictEqual(e.source, 'chat_title');
    assert.strictEqual(e.agent_type, 'system');
    assert.strictEqual(e.model, 'm');
    assert.strictEqual(e.prompt_tokens, 7);
    assert.strictEqual(e.completion_tokens, 3);
    assert.strictEqual(e.conversation_id, 'c1');
    assert.ok(e.duration_ms >= 0);
});

test('no usage from the provider is a zero-token row, and unknowns are null', () => {
    const e = surfaceUsageEntry({ source: 'voice' });
    assert.strictEqual(e.prompt_tokens, 0);
    assert.strictEqual(e.completion_tokens, 0);
    assert.strictEqual(e.user_id, null);
    assert.strictEqual(e.organization_id, null);
    assert.strictEqual(e.model, null);
    assert.strictEqual(e.duration_ms, null);
});

test('nothing beyond the listed fields reaches the row', () => {
    const e = surfaceUsageEntry(/** @type {any} */ ({ source: 'voice', prompt: 'secret text', answer: 'secret' }));
    assert.ok(!JSON.stringify(e).includes('secret'));
});

test('a failing sink never throws or rejects', async () => {
    logSurfaceUsage({ source: 'dictate' }, { logUsage: async () => { throw new Error('down'); } });
    logSurfaceUsage({ source: 'dictate' }, { logUsage: () => { throw new Error('down'); } });
    await new Promise((r) => setImmediate(r));
});

test('every source the unmetered surfaces log is a declared source with a real area', () => {
    for (const source of ['chat_title', 'automation_builder', 'meeting_summary', 'meeting_actions', 'kb_summary', 'notebook_chat',
        'notebook_generate', 'voice', 'dictate', 'nextcloud_assistant', 'agent_persona', 'template_chat', 'playbook']) {
        assert.ok(SOURCES[source], source);
        assert.notStrictEqual(areaOf(source), 'other', source);
    }
});

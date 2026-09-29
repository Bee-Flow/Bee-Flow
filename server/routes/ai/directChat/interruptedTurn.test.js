/**
 * Unit tests for interrupted-turn persistence message building.
 *
 * Run: node --test routes/ai/directChat/interruptedTurn.test.js
 */

const test = require('node:test');
const assert = require('assert');
const { buildInterruptedTurnMessages } = require('./interruptedTurn');

const BASE = [{ role: 'user', content: 'earlier', timestamp: '2026-07-19T10:00:00.000Z' }];

test('returns null when no side-effecting tool ran', () => {
    const msgs = buildInterruptedTurnMessages({
        baseMessages: BASE,
        tokenizedMessage: 'find my issues',
        toolHistory: [
            { name: 'youtrack_search_issues', args: { query: 'x' }, status: 'done', resultPreview: '{"count":0}' },
        ],
        errorNote: 'stream died',
    });
    assert.strictEqual(msgs, null);
});

test('returns null for an empty/missing toolHistory', () => {
    assert.strictEqual(buildInterruptedTurnMessages({ baseMessages: BASE, tokenizedMessage: 'x', toolHistory: [], errorNote: 'e' }), null);
    assert.strictEqual(buildInterruptedTurnMessages({ baseMessages: BASE, tokenizedMessage: 'x', errorNote: 'e' }), null);
});

test('persists user + assistant rows when a side effect ran', () => {
    const toolHistory = [
        { name: 'youtrack_search_issues', args: { query: 'x' }, status: 'done', resultPreview: '{"count":0}' },
        { name: 'youtrack_create_issue', args: { projectId: '0-1', summary: 'Bug' }, status: 'done', resultPreview: 'Issue created: PROJ-42 — "Bug"' },
    ];
    const msgs = buildInterruptedTurnMessages({
        baseMessages: BASE,
        tokenizedMessage: 'maak een issue aan',
        persistedAttachments: [{ name: 'log.txt' }],
        toolHistory,
        errorNote: 'API error: stream died',
    });

    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[0], BASE[0], 'base messages carried over');

    const userSave = msgs[1];
    assert.strictEqual(userSave.role, 'user');
    assert.strictEqual(userSave.content, 'maak een issue aan');
    assert.deepStrictEqual(userSave.attachments, [{ name: 'log.txt' }]);

    const assistantSave = msgs[2];
    assert.strictEqual(assistantSave.role, 'assistant');
    assert.strictEqual(assistantSave.interrupted, true);
    assert.strictEqual(assistantSave.toolHistory, toolHistory);
    assert.match(assistantSave.content, /ALREADY completed and MUST NOT be repeated/);
    assert.match(assistantSave.content, /youtrack_create_issue/);
    assert.match(assistantSave.content, /PROJ-42/);
    assert.match(assistantSave.content, /API error: stream died/);
    assert.ok(!assistantSave.content.includes('youtrack_search_issues'), 'read-only calls stay out of the note');
});

test('does not mutate baseMessages and tolerates a null base', () => {
    const base = [...BASE];
    buildInterruptedTurnMessages({
        baseMessages: base,
        tokenizedMessage: 'x',
        toolHistory: [{ name: 'youtrack_create_issue', args: {}, status: 'done', resultPreview: 'ok' }],
        errorNote: 'e',
    });
    assert.strictEqual(base.length, 1);

    const msgs = buildInterruptedTurnMessages({
        baseMessages: null,
        tokenizedMessage: 'x',
        toolHistory: [{ name: 'youtrack_create_issue', args: {}, status: 'done', resultPreview: 'ok' }],
        errorNote: 'e',
    });
    assert.strictEqual(msgs.length, 2);
});

test('classifier is injectable and unknown tools default to side-effecting', () => {
    const hist = [{ name: 'mcp_thing_send', args: {}, status: 'done', resultPreview: 'sent' }];
    const msgs = buildInterruptedTurnMessages({
        baseMessages: [], tokenizedMessage: 'x', toolHistory: hist, errorNote: 'e',
    });
    assert.ok(msgs, 'unknown tool treated as side effect (fail-closed)');

    const none = buildInterruptedTurnMessages({
        baseMessages: [], tokenizedMessage: 'x', toolHistory: hist, errorNote: 'e',
        isSideEffect: () => false,
    });
    assert.strictEqual(none, null);
});

test('long args are truncated in the note', () => {
    const msgs = buildInterruptedTurnMessages({
        baseMessages: [],
        tokenizedMessage: 'x',
        toolHistory: [{ name: 'youtrack_create_issue', args: { description: 'a'.repeat(500) }, status: 'done', resultPreview: 'ok' }],
        errorNote: 'e',
    });
    const line = msgs[1].content.split('\n')[1];
    assert.ok(line.length < 450, `note line stays compact (${line.length} chars)`);
});

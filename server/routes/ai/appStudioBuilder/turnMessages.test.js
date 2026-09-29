/**
 * The App Studio turn composition: one folded user message, few-shot policy,
 * head-anchored history — and the prefix that two turns share byte for byte.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeAppTurnMessages, foldUserTurn, stablePrefixLength } = require('./turnMessages');
const { DRAFT_STATE_PREFIX, EDITOR_CONTEXT_PREFIX, VALIDATION_NOTE_PREFIX } = require('./turnLoop');

const SYS = 'SYSTEM PROMPT — byte-stable';
const small = { toolset: 'core', fewShots: 2, fewShotPolicy: 'every-turn', historyBudgetTokens: 6000 };
const mid = { toolset: 'full', fewShots: 2, fewShotPolicy: 'first-turn', historyBudgetTokens: 8000 };

test('foldUserTurn: notes lead, the human closes, blanks are skipped; multimodal keeps its parts', () => {
    assert.deepEqual(foldUserTurn([`${DRAFT_STATE_PREFIX}\nx`, null, '', `${EDITOR_CONTEXT_PREFIX}\ny`], 'Build it'),
        { role: 'user', content: `${DRAFT_STATE_PREFIX}\nx\n\n${EDITOR_CONTEXT_PREFIX}\ny\n\nBuild it` });
    assert.deepEqual(foldUserTurn([], 'Just words'), { role: 'user', content: 'Just words' });
    const parts = [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }];
    assert.deepEqual(foldUserTurn(['[N]\nnote'], parts), { role: 'user', content: [{ type: 'text', text: '[N]\nnote' }, ...parts] });
    assert.deepEqual(foldUserTurn([], parts), { role: 'user', content: parts });
});

test('a turn never contains two consecutive user messages, and the machine notes sit in the last one', () => {
    const history = [
        { role: 'user', content: 'Earlier ask' },
        { role: 'user', content: `${VALIDATION_NOTE_PREFIX}\n[]` }, // stripped: loop-internal
        { role: 'assistant', content: 'Earlier answer' },
    ];
    const { messages } = composeAppTurnMessages({
        profile: mid, modelId: 'test-model', sys: SYS, history,
        notes: [`${DRAFT_STATE_PREFIX}\nstate`], userTurnContent: 'Now this',
    });
    assert.equal(messages[0].role, 'system');
    for (let i = 1; i < messages.length; i++) {
        assert.ok(!(messages[i].role === 'user' && messages[i - 1].role === 'user'), `consecutive user turns at ${i}`);
    }
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(last.content.startsWith(DRAFT_STATE_PREFIX));
    assert.ok(last.content.endsWith('Now this'));
    assert.equal(messages.filter((m) => typeof m.content === 'string' && m.content.includes(VALIDATION_NOTE_PREFIX)).length, 0, 'validation notes never return as history');
});

test('few-shots: every turn on the small profile, first turn only elsewhere, none for Gemini 3', () => {
    const shots = (c) => c.fewShotMessages.length;
    assert.ok(shots(composeAppTurnMessages({ profile: small, modelId: 'gemma', sys: SYS, history: [], notes: [], userTurnContent: 'a' })) > 0);
    assert.ok(shots(composeAppTurnMessages({ profile: small, modelId: 'gemma', sys: SYS, history: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], notes: [], userTurnContent: 'a' })) > 0, 'small keeps them on turn 2');
    assert.ok(shots(composeAppTurnMessages({ profile: mid, modelId: 'claude', sys: SYS, history: [], notes: [], userTurnContent: 'a' })) > 0);
    assert.equal(shots(composeAppTurnMessages({ profile: mid, modelId: 'claude', sys: SYS, history: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], notes: [], userTurnContent: 'a' })), 0, 'mid drops them once history exists');
    assert.equal(shots(composeAppTurnMessages({ profile: small, modelId: 'gemini-3.1-pro', sys: SYS, history: [], notes: [], userTurnContent: 'a' })), 0);
});

test('turn 2 starts with turn 1\'s exact prefix (system + few-shots), then turn 1 as history, then the folded tail', () => {
    const t1 = composeAppTurnMessages({ profile: small, modelId: 'gemma', sys: SYS, history: [], notes: ['[DRAFT]\nempty'], userTurnContent: 'Turn one' });
    const history = [{ role: 'user', content: 'Turn one' }, { role: 'assistant', content: 'Did it' }];
    const t2 = composeAppTurnMessages({ profile: small, modelId: 'gemma', sys: SYS, history, notes: ['[DRAFT]\nfull'], userTurnContent: 'Turn two' });
    const n = stablePrefixLength(t1); // system + few-shots (no history on turn 1)
    assert.equal(n, 1 + t1.fewShotMessages.length);
    assert.deepEqual(t2.messages.slice(0, n), t1.messages.slice(0, n));
    assert.deepEqual(t2.messages.slice(n, n + 2), history);
    assert.equal(t2.messages.at(-1).content, '[DRAFT]\nfull\n\nTurn two');
    assert.equal(stablePrefixLength(t2), n + 2);
});

test('history is windowed head-first in whole blocks, never a sliding tail', () => {
    const long = [];
    for (let i = 0; i < 40; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i} ${'word '.repeat(120)}` });
    const c = composeAppTurnMessages({ profile: { ...small, historyBudgetTokens: 3000 }, modelId: 'gemma', sys: SYS, history: long, notes: [], userTurnContent: 'x' });
    const kept = c.windowedHistory;
    assert.ok(kept.length < 40 && kept.length > 0);
    assert.equal(kept[0].role, 'user', 'the window never starts mid-exchange');
    assert.equal(kept.at(-1).content, long.at(-1).content, 'the newest message survives');
    // Appending two more messages under the same budget keeps the same head
    // until a block boundary is crossed — the prefix survives the append.
    const c2 = composeAppTurnMessages({ profile: { ...small, historyBudgetTokens: 3000 }, modelId: 'gemma', sys: SYS, history: [...long, { role: 'user', content: 'tiny' }, { role: 'assistant', content: 'ok' }], notes: [], userTurnContent: 'y' });
    assert.equal(c2.windowedHistory[0].content, kept[0].content, 'same head after a small append');
});

test('two users with different routines share the whole stable prefix; only the folded tail differs', () => {
    // The owner's routines/documents used to be rendered INTO the system
    // prompt (per user), so two users of one local box never shared the
    // ~7k-token prefix. They ride the OWNER CONTEXT note now, in the last
    // message, and the system prompt is one text for everyone.
    const { buildSystemPrompt, renderOwnerContextNote } = require('../../../appStudio/builderPrompt');
    const sys = buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' });
    const noteA = renderOwnerContextNote([{ id: 'auto_1', title: 'Alpha', isActive: true, trigger: 'manual' }], []);
    const noteB = renderOwnerContextNote([{ id: 'auto_2', title: 'Beta', isActive: true, trigger: 'webhook' }], [{ documentId: 'doc_1', name: 'Invoice', docType: 'invoice', placeholders: [] }]);
    const a = composeAppTurnMessages({ profile: small, modelId: 'gemma', sys, history: [], notes: [`${DRAFT_STATE_PREFIX}\nempty`, noteA], userTurnContent: 'Build an intake app' });
    const b = composeAppTurnMessages({ profile: small, modelId: 'gemma', sys: buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' }), history: [], notes: [`${DRAFT_STATE_PREFIX}\nempty`, noteB], userTurnContent: 'Build an orders app' });
    const n = stablePrefixLength(a);
    assert.deepEqual(a.messages.slice(0, n), b.messages.slice(0, n), 'system + few-shots identical across users');
    assert.notEqual(a.messages[n].content, b.messages[n].content);
    assert.ok(a.messages[n].content.includes('auto_1') && !a.messages[n].content.includes('auto_2'));
    assert.ok(b.messages[n].content.includes('doc_1'));
    assert.ok(a.messages[n].content.startsWith(DRAFT_STATE_PREFIX), 'draft state first, owner note after it, the human last');
    assert.ok(a.messages[n].content.endsWith('Build an intake app'));
});

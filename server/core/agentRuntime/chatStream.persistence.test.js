/**
 * BFSF-307 — the compacted LLM prompt must never be persisted as history.
 *
 * chatStream builds two arrays: `messages` (prompt-shaped — attachment-hydrated,
 * compacted, attachment-expanded) and `durableMessages` (real history). Before
 * the fix they were one variable, so `messages = compactedMessages` handed the
 * compacted prompt to `updateConversation` — a destructive full replace. Every
 * turn past the compaction threshold deleted the oldest turns from Postgres and
 * replaced them with compaction's synthetic priming pairs.
 *
 * WHAT THIS IS: a structural contract over chatStream's source. It pins the
 * invariants that make the two-array split hold, and it catches the exact
 * regression class — someone passing the wrong array to the store, or
 * reassigning the durable one.
 *
 * WHAT THIS IS NOT: an end-to-end run. chatStream has a large dependency graph
 * (agentStore, providers, guardrails, DLP, memory, …) and stubbing it whole via
 * the require cache produces a test that breaks whenever any of those move. A
 * behavioural test is still worth adding, but a brittle one that gets deleted
 * after its third false failure protects nothing. These assertions cost
 * milliseconds and cannot rot.
 *
 * Run: node --test core/agentRuntime/chatStream.persistence.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The two-array contract now spans the whole chatStream/ FOLDER and the phase
// modules its turn was decomposed into — scan them as one source so every push
// and every updateConversation call site stays under the same invariants.
// chatStream/ is expanded file by file: listing only its entry point would let
// the arrays be mishandled in any of its phases with this test still green.
const CHAT_STREAM_DIR = path.join(__dirname, 'chatStream');
const SRC = [
    ...fs.readdirSync(CHAT_STREAM_DIR).filter(f => f.endsWith('.js')).sort()
        .map(f => path.join('chatStream', f)),
    'attachmentIntake.js',
    'toolRoundExecutor.js',
    'finalizeTurn.js',
    'guardrailHardBlock.js',
].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

// Comments describe the invariants — including, deliberately, the forbidden
// patterns — so the "must not appear" assertions have to read CODE, not SRC.
const CODE = SRC.split('\n')
    .filter(l => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

test('updateConversation is only ever handed durableMessages', () => {
    const calls = [...SRC.matchAll(/agentStore\.updateConversation\(\s*([^)]*?)\)/gs)]
        .map(m => m[1].replace(/\s+/g, ' ').trim());
    assert.ok(calls.length > 0, 'no updateConversation call sites found — did the file move?');

    for (const args of calls) {
        const second = args.split(',')[1]?.trim();
        assert.ok(
            second === 'durableMessages' || second === 'updatedMessages',
            `updateConversation received "${second}" — only durableMessages (the real ` +
            `history) or updatedMessages (the redaction re-write, which re-reads from ` +
            `the DB) may be persisted. Passing the prompt array is BFSF-307.`
        );
    }
});

test('durableMessages is const, so it cannot be reassigned to the compacted prompt', () => {
    assert.match(SRC, /const durableMessages = \[\];/,
        'durableMessages must be declared const — that is what makes ' +
        '`durableMessages = compactedMessages` a syntax error rather than a silent regression');
    // Lookahead must swallow the whitespace itself: with `\s*=\s*(?!...)` the
    // engine backtracks the trailing \s* to zero and the negative lookahead
    // passes on " [];", matching the declaration it is meant to exempt.
    assert.doesNotMatch(CODE, /durableMessages\s*=(?!\s*\[\];)/,
        'durableMessages is reassigned somewhere');
});

test('compaction result lands on the prompt array only', () => {
    assert.match(SRC, /messages = compactedMessages;/,
        'expected the compacted array to be assigned to the PROMPT variable');
    assert.doesNotMatch(CODE, /durableMessages.*compactedMessages/,
        'the compacted prompt must never reach the durable array');
});

test('the tool-loop system nudge stays prompt-only', () => {
    // A persisted `system` row renders as an assistant bubble in the UI, and it
    // is a per-turn instruction rather than conversation.
    const idx = SRC.indexOf('A tool has failed repeatedly with identical arguments');
    assert.ok(idx > 0, 'the loop-bail nudge moved — re-check where it is pushed');
    const window = SRC.slice(Math.max(0, idx - 600), idx);
    assert.ok(window.includes('messages.push('), 'nudge should be pushed to the prompt array');
    assert.ok(!/durableMessages\.push\(\{\s*$/.test(window),
        'the loop-bail nudge must not be pushed to durableMessages');
});

test('every real turn that reaches the prompt also reaches the durable history', () => {
    // Assistant turns, tool results and the user turn are real history. If a
    // `messages.push(x)` appears for one of these without a matching
    // `durableMessages.push(x)`, that turn silently stops being persisted.
    for (const name of ['assistantMessage', 'assistantMsg', 'toolMsg']) {
        const prompt = SRC.includes(`messages.push(${name})`);
        const durable = SRC.includes(`durableMessages.push(${name})`);
        assert.strictEqual(prompt, durable,
            `${name} is pushed to one array but not the other`);
    }
    assert.match(SRC, /durableMessages\.push\(userMsg\);/,
        'the current user turn must be persisted');
    assert.match(SRC, /promptUserMsg = \{ \.\.\.userMsg \};/,
        'the prompt copy of the user turn must be a separate object — processAttachments ' +
        'mutates it in place and would otherwise inline the whole PDF into stored history');
});

test('edit/retry aligns the slim client history against the rich DB rows', () => {
    // Persisting historyOverride verbatim wipes attachment sidecars, id/parentId,
    // toolHistory, thinking, kbSources and tokenisationInfo from every earlier turn.
    assert.match(SRC, /alignClientToDb/,
        'the historyOverride branch must align the client history onto the DB rows');
    assert.match(SRC, /mergeAttachmentSidecars/,
        'the prompt side must graft sidecars back on so attachment replay still works');
    assert.doesNotMatch(CODE, /durableMessages\.push\(\.\.\.historyOverride\)/,
        'the slim client history must never be persisted verbatim');
});

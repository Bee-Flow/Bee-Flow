/**
 * Agent runtime — the empty-round guard (source pins).
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/chatStream.emptyRound.test.js
 *
 * chatStream.js is too DB-bound to execute in a unit test, so — like
 * chatStream.localAdapter.test.js — these pin the wiring by source pattern:
 * a round that ends with no text and no tool calls must NOT finalize as a
 * normal (empty) turn. That silent finalization was the "the conversation
 * just stops" defect on reasoning models (OpenAI Responses truncation,
 * Claude thinking-only max_tokens, a dropped malformed tool call).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// chatStream is a FOLDER now (chatStream/index.js plus the turn's phases), so
// every module in it is scanned as ONE source. A scan of index.js alone would
// keep passing while covering almost none of the code these pins exist for.
const CHAT_STREAM_DIR = path.join(__dirname, 'chatStream');
const SRC = fs.readdirSync(CHAT_STREAM_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => fs.readFileSync(path.join(CHAT_STREAM_DIR, f), 'utf8'))
    .join('\n');

test('the toolLoop guard helpers are imported', () => {
    assert.match(SRC, /const \{ isTruncatedStop, truncationRetryMessages, emptyReplyRetryMessages \} = require\('\.\.\/\.\.\/llm\/toolLoop'\)/);
});

test('the round stop reason is hoisted out of both streaming branches', () => {
    assert.match(SRC, /let _roundStopReason = null;/);
    // native adapter branch
    assert.match(SRC, /_roundStopReason = _adapterStreamUsage\?\.stop_reason \|\| null;/);
    // raw SSE branch
    assert.match(SRC, /_roundStopReason = _sseFinishReason \|\| null;/);
});

test('truncation termination logging accepts every adapter spelling', () => {
    assert.match(SRC, /if \(isTruncatedStop\(_roundStopReason\)\) \{\s*terminationStore\.logTermination/);
    assert.ok(!/stop_reason === 'max_tokens'\) \{\s*terminationStore/.test(SRC),
        'the single-spelling max_tokens check is gone');
});

test('dropped malformed tool calls are collected, not silently lost', () => {
    assert.match(SRC, /type === 'tool_use_invalid'\) \{/);
    assert.match(SRC, /_invalidToolCalls\.push\(data \|\| \{\}\)/);
    // and the per-attempt reset clears them so a retried stream can't double-count
    assert.match(SRC, /currentToolCalls = \[\];\s*_invalidToolCalls = \[\];/);
});

test('an error event on an unproductive stream throws (retryable), mid-stream errors do not', () => {
    assert.match(SRC, /if \(!contentBuffer && currentToolCalls\.length === 0\) \{\s*throw new Error\(data\?\.error/);
});

test('the empty-round guard retries truncation once, then nudges once, then speaks', () => {
    assert.match(SRC, /if \(!_forceFinalAnswer && \(!fullResponse \|\| !fullResponse\.trim\(\)\)\) \{/);
    assert.match(SRC, /isTruncatedStop\(_roundStopReason\) && !_truncationRetried/);
    assert.match(SRC, /messages\.push\(\.\.\.truncationRetryMessages\(fullResponse, _snapshotThinkingParts\(\)\)\);\s*continue;/);
    assert.match(SRC, /!isTruncatedStop\(_roundStopReason\) && !_emptyReplyRetried/);
    assert.match(SRC, /messages\.push\(\.\.\.emptyReplyRetryMessages\(fullResponse, _snapshotThinkingParts\(\), \{ rejected: _invalidToolCalls \}\)\);\s*continue;/);
    // after retries: a visible, non-empty placeholder — never a blank bubble
    assert.match(SRC, /The model hit its output length limit before it could answer/);
    assert.match(SRC, /The model returned an empty response\. Please try again\./);
});

test('the wrap-up round keeps its own fallback and is exempt from the guard', () => {
    const guardIdx = SRC.indexOf('if (!_forceFinalAnswer && (!fullResponse || !fullResponse.trim()))');
    const wrapIdx = SRC.indexOf('if (_forceFinalAnswer) {', guardIdx);
    assert.ok(guardIdx > -1 && wrapIdx > guardIdx, 'guard runs before the wrap-up fallback');
});

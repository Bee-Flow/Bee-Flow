/**
 * The shared build-loop mechanics. Both builders bind their own note prefix
 * and parameterless set onto these; a change here reaches both.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./toolLoop');

test('isTruncatedStop knows every adapter spelling of max_tokens', () => {
    for (const r of ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS']) assert.equal(L.isTruncatedStop(r), true, r);
    for (const r of ['stop', 'tool_calls', 'end_turn', '', null, undefined, 3]) assert.equal(L.isTruncatedStop(r), false, String(r));
});

test('truncationRetryMessages never yields an empty assistant message and frames the note with the caller prefix', () => {
    const [a, u] = L.truncationRetryMessages('', [], { notePrefix: '[NOTE]' });
    assert.equal(a.role, 'assistant');
    assert.equal(a.content, L.TRUNCATION_PLACEHOLDER);
    assert.equal('thinking' in a, false, 'no empty thinking array');
    assert.equal(u.role, 'user');
    assert.match(u.content, /^\[NOTE\]\nYour previous reply hit the length limit/);
    const [b] = L.truncationRetryMessages('half a thought', [{ text: 't', signature: 's' }]);
    assert.equal(b.content, 'half a thought');
    assert.deepEqual(b.thinking, [{ text: 't', signature: 's' }]);
    const [, plain] = L.truncationRetryMessages('x', null);
    assert.match(plain.content, /^Your previous reply/, 'no prefix → bare note');
});

test('providerErrorExcerpt prefers the JSON message and trims the rest', () => {
    assert.equal(L.providerErrorExcerpt('llamacpp API error 400: {"error":{"message":"roles must alternate"}}'), 'roles must alternate');
    assert.equal(L.providerErrorExcerpt('x API error 500:   plain   text  '), 'plain text');
    assert.equal(L.providerErrorExcerpt('a'.repeat(300), 20).length, 20);
    assert.equal(L.providerErrorExcerpt(null), '');
});

test('providerErrorStatus reads the status out of an adapter error', () => {
    assert.equal(L.providerErrorStatus(new Error('openai API error 400: bad')), 400);
    assert.equal(L.providerErrorStatus('x API error 429: slow'), 429);
    assert.equal(L.providerErrorStatus(new Error('socket hang up')), null);
    assert.equal(L.providerErrorStatus(undefined), null);
});

test('accumulateUsage tolerates partial payloads and counts rounds', () => {
    const t = L.emptyUsageTotals();
    L.accumulateUsage(t, { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 80 });
    L.accumulateUsage(t, { prompt_tokens: 'nope' });
    L.accumulateUsage(t, null);
    assert.deepEqual(t, { prompt: 100, completion: 10, cached: 80, cacheCreation: 0, rounds: 2 });
});

test('parseToolArgs flags truncation only for a non-empty unparseable string on a tool that takes params', () => {
    const paramless = new Set(['finalize']);
    assert.deepEqual(L.parseToolArgs({ a: 1 }, 'x'), { args: { a: 1 }, truncated: false });
    assert.deepEqual(L.parseToolArgs('', 'x'), { args: {}, truncated: false });
    assert.deepEqual(L.parseToolArgs(' {} ', 'x'), { args: {}, truncated: false });
    assert.deepEqual(L.parseToolArgs('{"a":1}', 'x'), { args: { a: 1 }, truncated: false });
    assert.deepEqual(L.parseToolArgs('{"a":', 'x', { paramless }), { args: {}, truncated: true });
    assert.deepEqual(L.parseToolArgs('{"a":', 'finalize', { paramless }), { args: {}, truncated: false });
    assert.deepEqual(L.parseToolArgs('{"a":', 'x'), { args: {}, truncated: true }, 'no paramless set → every tool takes params');
});

test('emptyReplyRetryMessages never yields an empty assistant message and names what the recovery saw', () => {
    const [a, u] = L.emptyReplyRetryMessages(null, [], { notePrefix: '[NOTE]' });
    assert.equal(a.role, 'assistant');
    assert.equal(a.content, L.EMPTY_REPLY_PLACEHOLDER);
    assert.equal(u.role, 'user');
    assert.match(u.content, /^\[NOTE\]\n/);
    assert.match(u.content, /no tool call and no message/);
    assert.doesNotMatch(u.content, /written out as text/);

    const [, withLeak] = L.emptyReplyRetryMessages('  ', [{ text: 't', signature: 's' }], {
        rejected: [{ name: 'app_make_table', reason: 'unknown_tool' }, { name: 'app_set_meta', reason: 'unparsable' }, { name: null, reason: 'unparsable' }, { name: 'app_make_table', reason: 'unknown_tool' }],
    });
    assert.match(withLeak.content, /`app_make_table` is not a tool on this menu/);
    assert.match(withLeak.content, /the arguments of `app_set_meta` did not parse/);
    assert.match(withLeak.content, /a call whose JSON did not parse/);
    assert.equal((withLeak.content.match(/app_make_table/g) || []).length, 1, 'duplicates collapse');
    assert.match(withLeak.content, /function-calling interface/);
    assert.doesNotMatch(withLeak.content, /^\[/, 'no prefix when none given');
});

test('emptyReplyRetryMessages keeps real content and signed thinking on the assistant message', () => {
    const [a] = L.emptyReplyRetryMessages('I paused.', [{ text: 't', signature: 's' }], {});
    assert.equal(a.content, 'I paused.');
    assert.deepEqual(a.thinking, [{ text: 't', signature: 's' }]);
});

test('isBlankReply: empty, whitespace and bare punctuation are blank; a word is not', () => {
    const { isBlankReply } = require('./toolLoop');
    for (const v of ['', '   ', '.', '…', '. .', null, undefined, '--']) assert.equal(isBlankReply(v), true, JSON.stringify(v));
    for (const v of ['Klaar.', 'ok', '1', 'Done — the app is finalized.']) assert.equal(isBlankReply(v), false, v);
});

/**
 * Agent runtime — self-hosted runtimes stream through the provider adapter.
 *
 * Until 2026-09 only the SDK providers took the adapter branch; every local
 * flavour fell through to a raw-fetch SSE path that built its own body: no
 * max_tokens, no enable_thinking / reasoning_effort / top_k, no late-system
 * fold, and the two system halves joined back into one — so an agent turn on
 * llama.cpp lost every tier knob AND re-read the whole prompt every turn.
 *
 * Source-regex pins (chatStream.js is too DB-bound to run here): the branch
 * predicate, the two things the raw path had that must survive the move
 * (client abort, 120 s ceiling), and the volatile-block placement.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/chatStream.localAdapter.test.js
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

test('useNativeAdapter includes the self-hosted runtimes', () => {
    assert.match(SRC, /const _adapterIsLocal = isLocalProviderType\(config\.providerType\) \|\| providerAdapter instanceof LocalProvider/);
    assert.match(SRC, /const useNativeAdapter = \(NATIVE_TYPES\.includes\(config\.providerType\) \|\| _adapterIsLocal\) && typeof providerAdapter\?\.stream === 'function'/);
    // From the leaf modules: the runtime tests mock the providers index down to
    // { getAdapter }, and a predicate pulled from the index came back undefined.
    // One '..' deeper than it reads, because this code lives in chatStream/ now.
    assert.match(SRC, /require\('\.\.\/\.\.\/providers\/localModels'\)/);
    assert.match(SRC, /require\('\.\.\/\.\.\/providers\/local'\)/);
});

test('the SDK list is unchanged — nothing hosted moved branches', () => {
    // 'eugpt' was added, not moved: EU GPT serves only /v1/responses, so the
    // raw /chat/completions path could never reach it.
    assert.match(SRC, /const NATIVE_TYPES = \['google', 'openai', 'claude', 'mistral', 'azure', 'google-vertex', 'eugpt'\]/);
    assert.match(SRC, /Raw fetch SSE streaming/, 'the raw path stays for everything else (Scaleway, unknown)');
});

test('a local adapter gets the client-abort signal and the stall watchdog', () => {
    assert.match(SRC, /if \(_adapterIsLocal\) \{[\s\S]*?adapterOptions\.signal = signal \|\| undefined;[\s\S]*?adapterOptions\.timeoutMs = 120000;/);
});

test('the volatile block is placed behind the history on the adapter branch', () => {
    assert.match(SRC, /placeVolatileBlock\(_layout, _volatileMessage\)/);
    assert.match(SRC, /require\('\.\.\/\.\.\/llm\/promptLayout'\)/);
});

test('cached_tokens is read from both spellings in the usage log', () => {
    // The turn logs `usageLogFields(_adapterStreamUsage)`; the one normaliser reads
    // the adapter spelling and the OpenAI-shaped one (usageNormalizer.test.js has the rest).
    assert.match(SRC, /\.\.\.usageLogFields\(_adapterStreamUsage\)/);
    const { usageLogFields } = require('../providers/usageNormalizer');
    assert.strictEqual(usageLogFields({ prompt_tokens: 10, cached_tokens: 7 }).cached_tokens, 7);
    assert.strictEqual(usageLogFields({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } }).cached_tokens, 5);
});

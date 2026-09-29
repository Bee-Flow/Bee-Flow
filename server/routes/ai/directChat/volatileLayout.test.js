/**
 * The per-round decisions of a streamed direct-chat turn, exercised by running
 * them.
 *
 * REGRESSION (measured 2026-09-11 against a single-slot llama.cpp server):
 * every turn re-read the whole prompt (4,375 tokens / 28.7 s) because the
 * step-machine guard was APPENDED to messages[0] — the block every provider
 * caches by byte prefix — and the guard text interpolates the round counter,
 * so it changed and grew every round. The fix has three moving parts, and all
 * three are behaviour, not spelling:
 *
 *   1. the guard REPLACES its tail (base + guard), so two rounds cannot stack;
 *   2. the volatile block MOVES behind the history for providers that fold or
 *      extract system messages, and is hoisted back for the ones that do not;
 *   3. the thrown-away tool pre-check is skipped for every provider whose
 *      stream path parses tool calls itself — self-hosted runtimes included.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/directChat/volatileLayout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { localAdapters } = require('../../../core/providers');
const { systemPrefixFingerprint } = require('../../../core/llm/promptCacheStability');
const log = require('../../../telemetry/log');
const {
    adapterIsLocal,
    skipToolPrecheck,
    layoutVolatile,
    createVolatileGuard,
    traceStablePrefix,
} = require('./volatileLayout');

/** A turn whose message list has the assembly-time shape [stable, volatile, …history, user]. */
function makeTurn({ providerType = 'claude', adapter = {}, modelId = 'm1' } = {}) {
    const volatileMessage = { role: 'system', content: 'Now: 2026-09-11T10:00:00Z' };
    const messages = [
        { role: 'system', content: 'STABLE IDENTITY PROMPT' },
        volatileMessage,
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'turn 2' },
    ];
    return {
        messages,
        volatileMessage,
        config: { providerType },
        adapter,
        modelId,
        chatOptions: {},
        directChatTools: [],
    };
}

// ═══ 1. The guard replaces its tail, never grows it ══════════════

test('a second round overwrites the first round\'s guard instead of stacking on it', () => {
    const turn = makeTurn();
    const base = turn.volatileMessage.content;
    const guard = createVolatileGuard(turn);

    guard.set('\n\n[STEP 1 of 3, round 1]');
    const afterFirst = turn.volatileMessage.content;
    assert.strictEqual(afterFirst, base + '\n\n[STEP 1 of 3, round 1]');

    guard.set('\n\n[STEP 1 of 3, round 2]');
    assert.strictEqual(
        turn.volatileMessage.content,
        base + '\n\n[STEP 1 of 3, round 2]',
        'round 2 must replace round 1\'s guard — an appending guard grows the block every round',
    );
    assert.ok(
        !turn.volatileMessage.content.includes('round 1'),
        'the previous round\'s guard text is still in the block',
    );
});

test('an empty guard restores the block to exactly what it was', () => {
    const turn = makeTurn();
    const base = turn.volatileMessage.content;
    const guard = createVolatileGuard(turn);

    guard.set('\n\n[STEP 2 of 3]');
    guard.set(null);
    assert.strictEqual(turn.volatileMessage.content, base);
    guard.set('');
    assert.strictEqual(turn.volatileMessage.content, base);
});

test('the guard never touches the cached block, whatever it is handed', () => {
    const turn = makeTurn();
    const stable = turn.messages[0].content;
    const guard = createVolatileGuard(turn);

    guard.set('\n\n[STEP 1]');
    guard.set('\n\n[STEP 2]');
    assert.strictEqual(turn.messages[0].content, stable, 'messages[0] is the provider-cached prefix');
});

test('capture() re-bases the guard on the block as it stands after the move', () => {
    const turn = makeTurn();
    const guard = createVolatileGuard(turn);

    // The PII/DLP addenda land on the block between assembly and the first
    // round; capture() is what makes them part of the base instead of text
    // the first guard write wipes out.
    turn.volatileMessage.content += '\n\n[PII TOKEN PRESERVATION] person_1 = …';
    const baseWithAddendum = turn.volatileMessage.content;
    guard.capture();
    guard.set('\n\n[STEP 1]');

    assert.strictEqual(turn.volatileMessage.content, baseWithAddendum + '\n\n[STEP 1]');
    guard.set(null);
    assert.strictEqual(
        turn.volatileMessage.content, baseWithAddendum,
        'clearing the guard must keep the addenda, not roll back to the assembly-time text',
    );
});

test('a turn with no volatile block is left alone rather than throwing', () => {
    const turn = makeTurn();
    turn.volatileMessage = null;
    const guard = createVolatileGuard(turn);
    guard.capture();
    assert.doesNotThrow(() => guard.set('\n\n[STEP 1]'));
    assert.strictEqual(turn.messages[0].content, 'STABLE IDENTITY PROMPT');
});

// ═══ 2. Where the block sits, per provider ═══════════════════════

test('for a provider that folds or extracts system messages the block moves behind the history', () => {
    for (const providerType of ['claude', 'google', 'google-vertex', 'openai', 'azure', 'mistral']) {
        const turn = makeTurn({ providerType });
        layoutVolatile(turn);

        const at = turn.messages.indexOf(turn.volatileMessage);
        const lastUser = turn.messages.map(m => m.role).lastIndexOf('user');
        assert.strictEqual(at, lastUser - 1, `${providerType}: the block must sit just before the last user message`);
        assert.strictEqual(turn.messages[0].content, 'STABLE IDENTITY PROMPT', `${providerType}: the cached block stays first`);
    }
});

test('for a strict-template provider the block is hoisted back to index 1', () => {
    const turn = makeTurn({ providerType: 'scaleway' });
    layoutVolatile(turn);
    assert.strictEqual(
        turn.messages.indexOf(turn.volatileMessage), 1,
        'Scaleway serves the models\' own chat templates and does not fold a late system message',
    );
});

test('a self-hosted runtime gets the late block even though its stored type is not in the safe set', () => {
    // Both routes to "this is local": the stored provider type …
    const byType = makeTurn({ providerType: 'ollama' });
    assert.ok(adapterIsLocal(byType));
    layoutVolatile(byType);
    assert.strictEqual(byType.messages.indexOf(byType.volatileMessage), byType.messages.length - 2);

    // … and the adapter instance, for a config whose type the URL heuristic guessed.
    const byAdapter = makeTurn({ providerType: 'custom-thing', adapter: localAdapters.llamacpp });
    assert.ok(adapterIsLocal(byAdapter));
    layoutVolatile(byAdapter);
    assert.strictEqual(byAdapter.messages.indexOf(byAdapter.volatileMessage), byAdapter.messages.length - 2);
});

test('the layout is idempotent and survives a mid-turn adapter swap', () => {
    const turn = makeTurn({ providerType: 'claude' });
    layoutVolatile(turn);
    const placed = turn.messages.map(m => m.role).join(',');
    layoutVolatile(turn);
    assert.strictEqual(turn.messages.map(m => m.role).join(','), placed, 're-running must not duplicate or drift the block');
    assert.strictEqual(turn.messages.filter(m => m === turn.volatileMessage).length, 1, 'exactly one copy of the block');

    // swapModelForActiveStage reassigns config/adapter between rounds.
    turn.config = { providerType: 'scaleway' };
    layoutVolatile(turn);
    assert.strictEqual(turn.messages.indexOf(turn.volatileMessage), 1, 'the swap must move the block back');
});

test('a tool round appended after the block leaves it before the current user message', () => {
    const turn = makeTurn({ providerType: 'claude' });
    layoutVolatile(turn);
    turn.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 't1' }] });
    turn.messages.push({ role: 'tool', tool_call_id: 't1', content: 'result' });
    layoutVolatile(turn);

    const at = turn.messages.indexOf(turn.volatileMessage);
    const lastUser = turn.messages.map(m => m.role).lastIndexOf('user');
    assert.strictEqual(at, lastUser - 1, 'the current turn\'s user message is still the last one');
});

// ═══ 3. The tool pre-check ═══════════════════════════════════════

test('the pre-check is skipped for every SDK provider', () => {
    for (const providerType of ['google', 'openai', 'claude', 'mistral']) {
        assert.strictEqual(skipToolPrecheck(makeTurn({ providerType })), true, providerType);
    }
});

test('the pre-check is skipped for a self-hosted runtime, by stored type and by adapter', () => {
    assert.strictEqual(skipToolPrecheck(makeTurn({ providerType: 'ollama' })), true, 'stored type');
    assert.strictEqual(skipToolPrecheck(makeTurn({ providerType: 'vllm' })), true, 'stored type');
    assert.strictEqual(
        skipToolPrecheck(makeTurn({ providerType: 'custom-thing', adapter: localAdapters.llamacpp })), true,
        'a URL-guessed local adapter has no stored type — the adapter identity is the only signal',
    );
});

test('the pre-check still runs for a provider that parses no tool calls in its stream', () => {
    assert.strictEqual(skipToolPrecheck(makeTurn({ providerType: 'scaleway' })), false);
});

test('a Responses-API model skips the pre-check whatever its provider type says', () => {
    const turn = makeTurn({
        providerType: 'scaleway',
        adapter: { shouldUseResponsesApi: (modelId) => modelId === 'gpt-5' },
    });
    assert.strictEqual(skipToolPrecheck(turn), false, 'm1 is not a Responses-API model');
    turn.modelId = 'gpt-5';
    assert.strictEqual(skipToolPrecheck(turn), true);
});

test('the decision is taken per round, so a mid-turn swap changes it', () => {
    const turn = makeTurn({ providerType: 'scaleway' });
    assert.strictEqual(skipToolPrecheck(turn), false);
    turn.config = { providerType: 'claude' };
    assert.strictEqual(skipToolPrecheck(turn), true, 'swapModelForActiveStage can change the answer between rounds');
});

// ═══ 4. The stable-prefix trace ══════════════════════════════════

test('the trace names the cached block\'s fingerprint and where the volatile block landed', () => {
    const turn = makeTurn({ providerType: 'claude' });
    layoutVolatile(turn);

    const lines = [];
    const realInfo = log.info;
    log.info = (line) => lines.push(String(line));
    try { traceStablePrefix(turn, 'placed'); } finally { log.info = realInfo; }

    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes(`system=${systemPrefixFingerprint('STABLE IDENTITY PROMPT')}`),
        `the fingerprint of messages[0] must be in the line, got: ${lines[0]}`);
    assert.ok(lines[0].includes(`volatileAt=${turn.messages.indexOf(turn.volatileMessage)}/${turn.messages.length}`),
        `the block's position must be in the line, got: ${lines[0]}`);

    // Two turns of one conversation share the cached prefix only if the
    // fingerprint is the same; a guard write must not change it.
    const other = makeTurn({ providerType: 'claude' });
    createVolatileGuard(other).set('\n\n[STEP 1]');
    const lines2 = [];
    log.info = (line) => lines2.push(String(line));
    try { traceStablePrefix(other, 'placed'); } finally { log.info = realInfo; }
    assert.strictEqual(
        lines2[0].split(' tools=')[0].split('system=')[1],
        lines[0].split(' tools=')[0].split('system=')[1],
        'the guard changed the cacheable prefix',
    );
});

/**
 * Prompt-cache prefix stability.
 *
 * Anthropic's prompt cache is a prefix match over `tools → system → messages`,
 * and the Claude adapter places a 1-hour cache_control breakpoint on the FIRST
 * system block only. So the cacheable prefix is exactly "the tool list plus
 * system[0]", and it must be byte-identical across the turns of a conversation
 * or every request pays a full-price write (at 2x, for a 1h TTL).
 *
 * The regression these tests guard against: a second-resolution `Now:` line,
 * relevance-retrieved memories, and per-query KB chunks were all being
 * concatenated into that first block, so the hit rate was structurally zero on
 * the agent path.
 *
 * Run: node --test core/promptCacheStability.test.js
 * Pure prompt-shaping — no network, no DB, no SDK client.
 */

const assert = require('assert');
const test = require('node:test');

const { toolSetFingerprint, toolBytesFingerprint, systemPrefixFingerprint } = require('./promptCacheStability');
const { processSystemPrompt, CLOCK_TAG_PLACEHOLDER } = require('./promptUtils');
const ClaudeProvider = require('../providers/claude');

const provider = new ClaudeProvider();

// ── fingerprints ──────────────────────────────────────────────────────────

test('toolBytesFingerprint sees what toolSetFingerprint cannot: a changed description or schema', () => {
    const a = [{ type: 'function', function: { name: 'alpha', description: 'one', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }];
    const b = [{ type: 'function', function: { name: 'alpha', description: 'two', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }];
    const c = [{ type: 'function', function: { name: 'alpha', description: 'one', parameters: { type: 'object', properties: { x: { type: 'string', enum: ['a'] } } } } }];
    assert.strictEqual(toolSetFingerprint(a), toolSetFingerprint(b), 'same names → same set fingerprint');
    assert.notStrictEqual(toolBytesFingerprint(a), toolBytesFingerprint(b), 'a description edit moves the bytes');
    assert.notStrictEqual(toolBytesFingerprint(a), toolBytesFingerprint(c), 'a schema edit moves the bytes');
    assert.strictEqual(toolBytesFingerprint(a), toolBytesFingerprint(JSON.parse(JSON.stringify(a))), 'equal bytes, equal digest');
    assert.strictEqual(toolBytesFingerprint([]), 'none');
    assert.strictEqual(toolBytesFingerprint(null), 'none');
    assert.match(toolBytesFingerprint(a), /^[0-9a-f]{12}$/);
});

test('toolSetFingerprint is order-sensitive', () => {
    const a = [{ function: { name: 'alpha' } }, { function: { name: 'beta' } }];
    const b = [{ function: { name: 'beta' } }, { function: { name: 'alpha' } }];

    assert.strictEqual(toolSetFingerprint(a), toolSetFingerprint(a.map(t => ({ ...t }))));
    assert.notStrictEqual(
        toolSetFingerprint(a),
        toolSetFingerprint(b),
        'same names in a different order is a different wire prefix — the fingerprint must say so',
    );
    assert.strictEqual(toolSetFingerprint([]), 'none');
    assert.strictEqual(toolSetFingerprint(undefined), 'none');
});

test('systemPrefixFingerprint changes on a single byte', () => {
    assert.strictEqual(systemPrefixFingerprint('You are helpful.'), systemPrefixFingerprint('You are helpful.'));
    assert.notStrictEqual(systemPrefixFingerprint('You are helpful.'), systemPrefixFingerprint('You are helpful!'));
    assert.strictEqual(systemPrefixFingerprint(''), 'empty');
});

// ── clock tags must not reach a cached block ──────────────────────────────

test('processSystemPrompt defers {Time}/{DateTime} so a user template cannot poison the prefix', () => {
    const template = 'You are an assistant. It is {Time} on {DateTime}. Today: {Date}.';

    const first = processSystemPrompt(template, { deferClockTags: true });
    const second = processSystemPrompt(template, { deferClockTags: true });

    assert.strictEqual(first, second, 'deferred form must be byte-stable across calls');
    assert.ok(first.includes(CLOCK_TAG_PLACEHOLDER), 'clock tags resolve to the stable pointer');
    assert.ok(!/{Time}|{DateTime}/.test(first), 'tags are consumed, not left literal');
    // {Date} only rotates daily, so it stays inline.
    assert.ok(!first.includes('{Date}'), '{Date} is still expanded inline');
});

test('processSystemPrompt without the option keeps the legacy live-clock behaviour', () => {
    const out = processSystemPrompt('now: {Time}');
    assert.ok(!out.includes(CLOCK_TAG_PLACEHOLDER));
    assert.ok(!out.includes('{Time}'));
});

// ── the adapter's half of the contract ────────────────────────────────────

test('extractSystem caches only the first block', () => {
    const blocks = provider.extractSystem([
        { role: 'system', content: 'stable identity + tools' },
        { role: 'system', content: 'Now: 2026-08-11 13:04:00' },
        { role: 'user', content: 'hi' },
    ]);

    assert.strictEqual(blocks.length, 2);
    assert.deepStrictEqual(blocks[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.strictEqual(blocks[1].cache_control, undefined,
        'the volatile block must never carry a breakpoint — it would churn writes every turn');
});

test('two turns that differ only in volatile context share a byte-identical cached prefix', () => {
    const stable = 'You are Bee Flow. Tools: notebook_read, notebook_write.';

    const turn1 = provider.extractSystem([
        { role: 'system', content: stable },
        { role: 'system', content: 'Now: 2026-08-11 13:04:00\n\n[MEMORY]\nUser prefers Dutch.' },
    ]);
    const turn2 = provider.extractSystem([
        { role: 'system', content: stable },
        { role: 'system', content: 'Now: 2026-08-11 13:07:42\n\n[MEMORY]\nUser is based in Utrecht.\n\n[KB]\nchunk' },
    ]);

    assert.strictEqual(turn1[0].text, turn2[0].text);
    assert.strictEqual(
        systemPrefixFingerprint(turn1[0].text),
        systemPrefixFingerprint(turn2[0].text),
        'the cached block must not move when only per-turn context changed',
    );
    assert.notStrictEqual(turn1[1].text, turn2[1].text, 'the volatile block is expected to differ');
});

test('the pre-fix shape — one combined system message — is detectably unstable', () => {
    // Guards the inverse: if someone re-merges the halves, this is what the
    // adapter sees, and the assertion above would silently start passing on a
    // prefix that changes every second.
    const combined = (now) => provider.extractSystem([
        { role: 'system', content: `You are Bee Flow.\nNow: ${now}` },
    ]);

    assert.notStrictEqual(
        combined('2026-08-11 13:04:00')[0].text,
        combined('2026-08-11 13:04:01')[0].text,
    );
});

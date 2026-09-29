/**
 * releaseNotesDrafter — unit tests.
 *
 * Run: node --test core/releaseNotesDrafter.test.js
 *
 * llmClient and modelResolver are stubbed out of require.cache, so no model
 * call and no DB.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Stubs, installed before the module under test loads ────────────────
let _reply = '';
let _calls = [];

const llmPath = require.resolve('./llm/llmClient');
require.cache[llmPath] = {
    id: llmPath, filename: llmPath, loaded: true,
    exports: {
        chat: async (modelId, messages, opts) => {
            _calls.push({ modelId, messages, opts });
            return { content: _reply };
        },
    },
};

const resolverPath = require.resolve('./llm/modelResolver');
require.cache[resolverPath] = {
    id: resolverPath, filename: resolverPath, loaded: true,
    exports: { resolveModelForTierName: async () => 'stub-model' },
};

const drafter = require('./releaseNotesDrafter');

function reset() { _reply = ''; _calls = []; }

// ── _normaliseLines ────────────────────────────────────────────────────

test('_normaliseLines splits a newline blob, trims and drops blanks', () => {
    assert.deepStrictEqual(
        drafter._normaliseLines('  a \n\n b \n'),
        ['a', 'b']
    );
});

test('_normaliseLines de-duplicates — several commits with one subject are one line', () => {
    assert.deepStrictEqual(drafter._normaliseLines(['fix: x', 'fix: x', 'fix: y']), ['fix: x', 'fix: y']);
});

test('_normaliseLines caps runaway input', () => {
    const many = Array.from({ length: 500 }, (_, i) => `commit ${i}`);
    assert.strictEqual(drafter._normaliseLines(many).length, 200);
});

// ── _stripFence ────────────────────────────────────────────────────────

test('_stripFence removes a ```json fence the model was told not to add', () => {
    assert.strictEqual(drafter._stripFence('```json\n{"a":1}\n```'), '{"a":1}');
    assert.strictEqual(drafter._stripFence('```\n{"a":1}\n```'), '{"a":1}');
    assert.strictEqual(drafter._stripFence('{"a":1}'), '{"a":1}');
});

// ── _coerceDraft ───────────────────────────────────────────────────────

test('_coerceDraft keeps a well-formed draft', () => {
    const out = drafter._coerceDraft({
        title: 'Release', lead: 'Some things changed.',
        items: [{ kind: 'fix', title: 'A', body: 'B' }],
    });
    assert.strictEqual(out.title, 'Release');
    assert.deepStrictEqual(out.items, [{ kind: 'fix', title: 'A', body: 'B' }]);
});

test('AN UNKNOWN KIND IS RE-BUCKETED, NEVER DROPPED', () => {
    // Same principle the roadmap block applies to an unrecognised status:
    // losing a real change because the model wrote "enhancement" is worse than
    // filing it under a slightly wrong heading.
    const out = drafter._coerceDraft({ items: [{ kind: 'enhancement', title: 'A', body: 'B' }] });
    assert.strictEqual(out.items.length, 1);
    assert.strictEqual(out.items[0].kind, 'improvement');
});

test('_coerceDraft drops entries with neither title nor body', () => {
    const out = drafter._coerceDraft({ items: [{ kind: 'fix' }, { kind: 'fix', title: 'real' }] });
    assert.strictEqual(out.items.length, 1);
});

test('_coerceDraft survives garbage without throwing', () => {
    for (const bad of [null, undefined, 'string', 42, { items: 'nope' }, { items: [null, 7] }]) {
        const out = drafter._coerceDraft(bad);
        assert.ok(Array.isArray(out.items), `items must be an array for ${JSON.stringify(bad)}`);
    }
});

test('_coerceDraft caps item count and title length', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ kind: 'fix', title: `t${i}`, body: 'b' }));
    assert.strictEqual(drafter._coerceDraft({ items }).items.length, 25);
    const long = drafter._coerceDraft({ title: 'x'.repeat(500), items: [] });
    assert.strictEqual(long.title.length, 120);
});

// ── draftReleaseNotes ──────────────────────────────────────────────────

test('an empty range does NOT spend a model call', async () => {
    reset();
    const out = await drafter.draftReleaseNotes({ commitSubjects: [], prTitles: [] });
    assert.deepStrictEqual(out, { title: '', lead: '', items: [] });
    assert.strictEqual(_calls.length, 0, 'no model call should have been made');
});

test('draftReleaseNotes sends the material and returns the coerced draft', async () => {
    reset();
    _reply = JSON.stringify({ title: 'T', lead: 'L', items: [{ kind: 'feature', title: 'F', body: 'B' }] });
    const out = await drafter.draftReleaseNotes({
        commitSubjects: ['feat: thing'], prTitles: ['Merge pull request #1 from x'], version: 'v1',
    });
    assert.strictEqual(out.title, 'T');
    assert.strictEqual(out.items[0].kind, 'feature');
    assert.strictEqual(_calls.length, 1);
    const userMsg = _calls[0].messages[1].content;
    assert.match(userMsg, /feat: thing/);
    assert.match(userMsg, /Version: v1/);
});

test('A MALFORMED REPLY YIELDS EMPTY, NOT A THROW', async () => {
    reset();
    // The build that triggered this must not fail, and garbage must not reach
    // the changelog. The next dev build recomputes the same range anyway.
    _reply = 'I am afraid I cannot do that';
    const out = await drafter.draftReleaseNotes({ commitSubjects: ['x'] });
    assert.deepStrictEqual(out, { title: '', lead: '', items: [] });
});

test('the diffstat is truncated rather than sent whole', async () => {
    reset();
    _reply = '{"items":[]}';
    await drafter.draftReleaseNotes({ commitSubjects: ['x'], diffstat: 'y'.repeat(10000) });
    const userMsg = _calls[0].messages[1].content;
    assert.ok(userMsg.length < 6000, `payload should be bounded, got ${userMsg.length}`);
});

test('the prompt forbids internal identifiers reaching customers', () => {
    // Guarding the instruction itself: this is the rule that keeps file paths
    // and BFSF ids out of public copy.
    assert.match(drafter.SYSTEM_PROMPT, /no file paths/i);
    assert.match(drafter.SYSTEM_PROMPT, /BFSF/);
    assert.match(drafter.SYSTEM_PROMPT, /Never invent/i);
});

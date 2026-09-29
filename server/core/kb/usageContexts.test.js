/**
 * The surface question, and the one way it must never fail.
 *
 * A NULL `usage_contexts` predates the column. Every picker has always read it
 * as "no restriction was expressed" — so the moment a link-time check starts
 * ASKING, a strict reading would remove bases from surfaces their owner never
 * touched, on installs that had simply never set the value. The failure
 * direction is the whole test.
 *
 * Run: cd server && node --test --test-force-exit core/kb/usageContexts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { kbUsableIn, contextsOf, normaliseContexts, EDITABLE_SURFACES } = require('./usageContexts');

test('a base says which surfaces it is for', () => {
    const kb = { usage_contexts: ['agent', 'ai_step'] };
    assert.strictEqual(kbUsableIn(kb, 'agent'), true);
    assert.strictEqual(kbUsableIn(kb, 'ai_step'), true);
    assert.strictEqual(kbUsableIn(kb, 'direct_chat'), false);
});

test('the column read back as TEXT parses the same', () => {
    // jsonb on the column; some read paths hand back the raw string.
    assert.strictEqual(kbUsableIn({ usage_contexts: '["agent"]' }, 'agent'), true);
    assert.strictEqual(kbUsableIn({ usage_contexts: '["agent"]' }, 'ai_step'), false);
});

test('a value that was never expressed means EVERYWHERE, not nowhere', () => {
    for (const kb of [{ usage_contexts: null }, { usage_contexts: undefined }, {}, null]) {
        for (const surface of EDITABLE_SURFACES) {
            assert.strictEqual(kbUsableIn(kb, surface), true, `${JSON.stringify(kb)} / ${surface}`);
        }
    }
});

test('a value that will not parse also means everywhere', () => {
    // The safe direction for a SURFACE question is permissive: kbVisibility is
    // what stands between a person and the content, and a parse failure here
    // must not silently unlink a base from every routine that uses it.
    assert.strictEqual(kbUsableIn({ usage_contexts: 'not json' }, 'agent'), true);
    assert.strictEqual(kbUsableIn({ usage_contexts: '{"agent":true}' }, 'agent'), true);
    assert.strictEqual(kbUsableIn({ usage_contexts: 42 }, 'agent'), true);
});

test('an EXPLICIT empty list is a real answer, and it is "nowhere"', () => {
    // Different from never having answered: somebody unticked every box.
    assert.deepStrictEqual(contextsOf({ usage_contexts: [] }), []);
    assert.strictEqual(kbUsableIn({ usage_contexts: [] }, 'agent'), false);
});

test('normalising a payload drops values that are not surfaces', () => {
    assert.deepStrictEqual(normaliseContexts(['agent', 'nonsense', 'ai_step']), ['agent', 'ai_step']);
    assert.deepStrictEqual(normaliseContexts(['agent', 'agent']), ['agent']);
    assert.strictEqual(normaliseContexts(['nonsense']), null, 'nothing valid = leave as-is');
    assert.strictEqual(normaliseContexts(undefined), null);
    assert.strictEqual(normaliseContexts('agent'), null);
});

/**
 * tokenizeMemoryContext: the memory block carries reversible conversation
 * tokens, so "My name is tom" is answered "Je naam is tom" instead of the
 * model reading "My name is [User's name]". Dependencies are injected.
 *
 * Run: cd server && node --test core/memory/scrubMemoryContext.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { tokenizeMemoryContext } = require('./scrubMemoryContext');
const { tokenizeText } = require('../privacy/piiDetection/tokenizer');
const { createUntokeniser } = require('../dlp/untokeniseStream');
const { buildTokenPreservationAddendum } = require('../dlp/tokenPreservationPrompt');

const MEMORY = '## Active Memory\n- My name is tom';

function fakeDeps({ failTokenize = false, failDetect = false } = {}) {
    const maps = new Map();
    const dlpRunner = {
        getConversationTokenMap: (id) => maps.get(id) || {},
        getConversationTokenMapAsync: async (id) => maps.get(id) || {},
        mergeTokenMap: (id, m) => { maps.set(id, { ...(maps.get(id) || {}), ...m }); },
    };
    return {
        maps, dlpRunner,
        ALL_PII_CATEGORY_IDS: ['Person'],
        DEFAULT_PII_CONFIDENCE_THRESHOLD: 0.7,
        detectPii: async (text) => {
            if (failDetect) throw new Error('guard down');
            const i = text.indexOf('tom');
            return { hasPii: i >= 0, entities: i < 0 ? [] : [{ category: 'Person', label: 'Person', text: 'tom', offset: i, length: 3 }] };
        },
        tokenizeText: (...a) => { if (failTokenize) throw new Error('boom'); return tokenizeText(...a); },
        buildSeed: async (_u, _e, existing) => ({ tokenMap: { ...existing }, counterFloors: {} }),
        filterAllowed: (e) => e,
    };
}

test('shield on: memory gets a reversible token, map + addendum + stream restore it', async () => {
    const deps = fakeDeps();
    const r = await tokenizeMemoryContext(MEMORY, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps });
    assert.strictEqual(r.mode, 'tokens');
    assert.match(r.text, /My name is \[person_1\]/i);
    assert.ok(!r.text.includes('tom'));
    assert.ok(!r.text.includes("[User's name]"));
    const map = deps.dlpRunner.getConversationTokenMap('c1');
    const token = Object.keys(map)[0];
    assert.strictEqual(map[token], 'tom');
    assert.ok(buildTokenPreservationAddendum(map).includes('`' + token + '`'));
    const ut = createUntokeniser(() => deps.dlpRunner.getConversationTokenMap('c1'));
    assert.strictEqual(ut.push(`Je naam is ${token}`) + ut.flush(), 'Je naam is tom');
});

test('the same value keeps its token across a second call', async () => {
    const deps = fakeDeps();
    const a = await tokenizeMemoryContext(MEMORY, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps });
    const b = await tokenizeMemoryContext(MEMORY, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps });
    assert.strictEqual(a.text, b.text);
});

test('tokenising fails: label scrub, raw value never sent', async () => {
    const r = await tokenizeMemoryContext(MEMORY, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps: fakeDeps({ failTokenize: true }) });
    assert.strictEqual(r.mode, 'labels');
    assert.ok(!r.text.includes('tom'));
    assert.match(r.text, /\[name\]/);
});

test('no PII found: text unchanged', async () => {
    const r = await tokenizeMemoryContext('## Active Memory\n- likes tea', { enabled: true }, { conversationId: 'c1', deps: fakeDeps() });
    assert.strictEqual(r.mode, 'none');
    assert.strictEqual(r.text, '## Active Memory\n- likes tea');
});

test('empty input is returned as an empty string', async () => {
    const r = await tokenizeMemoryContext('', null, { conversationId: 'c1', deps: fakeDeps() });
    assert.strictEqual(r.text, '');
});

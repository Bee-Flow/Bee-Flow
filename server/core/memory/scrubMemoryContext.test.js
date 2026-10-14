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

test('tokens mode carries the note that the placeholder is the user\'s own value', async () => {
    const deps = fakeDeps();
    const block = '<memories>\n## Active Memory\n- My name is tom\n</memories>\n';
    const r = await tokenizeMemoryContext(block, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps });
    assert.strictEqual(r.mode, 'tokens');
    const token = Object.keys(r.tokenMap)[0];
    assert.ok(r.text.includes(`Placeholders such as \`${token}\` in these notes stand for the user's own data`));
    assert.match(r.text, /answer with the placeholder verbatim, never that it is unknown/);
    // Inside the block, so it is remembered data, not a free-standing instruction.
    assert.ok(r.text.indexOf('Placeholders such as') < r.text.indexOf('</memories>'));
    assert.ok(r.text.trimEnd().endsWith('</memories>'));
});

test('label mode and untouched text carry no note', async () => {
    const labels = await tokenizeMemoryContext(MEMORY, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps: fakeDeps({ failTokenize: true }) });
    assert.ok(!labels.text.includes('Placeholders such as'));
    const none = await tokenizeMemoryContext('## Active Memory\n- likes tea', { enabled: true }, { conversationId: 'c1', deps: fakeDeps() });
    assert.ok(!none.text.includes('Placeholders such as'));
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

// ─── Account identity (userIdentityContext) ──────────────────────────
const { buildUserIdentity } = require('./userIdentityContext');

function silentDeps() {
    const deps = fakeDeps();
    deps.ALL_PII_CATEGORY_IDS = ['Person', 'Email', 'Organization'];
    deps.detectPii = async () => ({ hasPii: false, entities: [] });
    return deps;
}

test('account name and e-mail are tokenised although the detector finds nothing', async () => {
    const deps = silentDeps();
    const id = buildUserIdentity({ displayName: 'Ada Visser', email: 'ada@example.test' });
    const r = await tokenizeMemoryContext(id.text, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps, knownEntities: id.knownEntities });
    assert.strictEqual(r.mode, 'tokens');
    assert.ok(!r.text.includes('Ada Visser'));
    assert.ok(!r.text.includes('ada@example.test'));
    const nameTok = Object.keys(r.tokenMap).find((t) => r.tokenMap[t] === 'Ada Visser');
    const mailTok = Object.keys(r.tokenMap).find((t) => r.tokenMap[t] === 'ada@example.test');
    assert.ok(r.text.includes(`Name: ${nameTok}`));
    assert.ok(r.text.includes(`\`${nameTok}\` is the user's name`));
    assert.ok(r.text.includes(`\`${mailTok}\` is the user's e-mail address`));
    const ut = createUntokeniser(() => deps.dlpRunner.getConversationTokenMap('c1'));
    assert.strictEqual(ut.push(`Je heet ${nameTok} (${mailTok})`) + ut.flush(), 'Je heet Ada Visser (ada@example.test)');
});

test('a first name in a memory folds onto the token of the account name', async () => {
    const deps = fakeDeps();
    deps.ALL_PII_CATEGORY_IDS = ['Person', 'Email'];
    deps.detectPii = async (text) => {
        const i = text.indexOf('- My name is Ada');
        const at = i + '- My name is '.length;
        return { hasPii: true, entities: [{ category: 'Person', text: 'Ada', offset: at, length: 3 }] };
    };
    const id = buildUserIdentity({ displayName: 'Ada Visser' });
    const text = id.text + '<memories>\n- My name is Ada\n</memories>\n';
    const r = await tokenizeMemoryContext(text, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps, knownEntities: id.knownEntities });
    const toks = Object.keys(r.tokenMap);
    assert.strictEqual(toks.length, 1, JSON.stringify(r.tokenMap));
    assert.ok(r.text.includes(`Name: ${toks[0]}`));
    assert.ok(r.text.includes(`My name is ${toks[0]}`));
});

test('a category the org switched off stays plain', async () => {
    const deps = silentDeps();
    const id = buildUserIdentity({ displayName: 'Ada Visser', email: 'ada@example.test' });
    const r = await tokenizeMemoryContext(id.text, { enabled: true, piiDetectionCategories: ['Email'] }, { conversationId: 'c1', userId: 'u1', deps, knownEntities: id.knownEntities });
    assert.ok(r.text.includes('Ada Visser'));
    assert.ok(!r.text.includes('ada@example.test'));
});

test('detector down: the account values are still tokenised', async () => {
    const deps = fakeDeps({ failDetect: true });
    deps.ALL_PII_CATEGORY_IDS = ['Person'];
    const id = buildUserIdentity({ displayName: 'Ada Visser' });
    const r = await tokenizeMemoryContext(id.text, { enabled: true }, { conversationId: 'c1', userId: 'u1', deps, knownEntities: id.knownEntities });
    assert.strictEqual(r.mode, 'tokens');
    assert.ok(!r.text.includes('Ada Visser'));
});

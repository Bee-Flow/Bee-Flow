/**
 * BFSF-354 — an agent without kb_search gets its passages injected by
 * performKnowledgeSearch, each under a "### Source N: <label>" line. The label
 * is the document's title or address, and a title can carry the very data the
 * Privacy Shield's "own server" list forbids (an e-mail archive titles every
 * message by its sender). The caller's strip hook hands back the labels after
 * the same scan as the passages; this pins that the prompt uses them, while
 * the citation keeps the real title.
 *
 * Retrieval and the stores are stubbed through testUtils/stubRequire; the
 * real gate runs with its detector injected. Test data is synthetic.
 *
 * Run: cd server && node --test core/agentRuntime/knowledgeSearch.shieldLabels.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { SYNTH_EMAIL, OWN_SERVER_EMAIL, configStoreStub, injectEmailDetector } = require('../../testUtils/toolPiiGateHarness');

const fx = { chunks: [] };

const restore = installResolveStub({
    '../../stores/configStore': configStoreStub(),
    '../serviceAuth': { getServiceHeaders: () => ({}) },
    '../../db': { getAll: async () => [] },
    '../entitlements/betaFeatures': { userHasBetaFeature: async () => false },
    '../kb/kbVisibility': { filterKbIdsForEmbed: async (ids) => ids },
    '../kb/askerContext': { askerContext: async () => ({ orgIds: new Set() }) },
    './testAs': { visibleKbIdsFor: async (ids) => ids, coerceTestAs: () => null },
    '../kb/resolveProvider': { resolveKbProvider: async () => 'local' },
    '../kb/localKBIngest': { searchLocally: async () => fx.chunks.map(c => ({ ...c })) },
});
test.after(() => restore());

const toolPiiGate = injectEmailDetector(require('../privacy/toolPiiGate'));

const { performKnowledgeSearch } = require('./knowledgeSearch');

/** The hook contextEnrichment passes in, over the real gate. */
const stripWith = (shield) => async (chunks, labelOf) => {
    const r = await toolPiiGate.stripBlockedFromKbChunks(chunks, shield, { fields: ['content'], labelOf });
    return r.sourceLabels;
};

async function search(stripPassages) {
    const events = [];
    const text = await performKnowledgeSearch({
        agent: { id: 'a1', config: { knowledge_base_ids: ['kb1'], includeSourceReferences: true } },
        userId: 'u1',
        userMessage: 'who sent the latest invoice',
        isStrictKnowledge: false,
        onEvent: (type, data) => events.push({ type, data }),
        session: null,
        stripPassages,
    });
    return { text, sources: events.find(e => e.type === 'kb_sources')?.data?.sources || [] };
}

test.beforeEach(() => {
    fx.chunks = [{ content: 'the invoice is attached', title: `${SYNTH_EMAIL} — invoice`, source_uri: '', document_id: 'd1', score: 0.5 }];
});

test('the injected source label loses what the own-server list blocks', async () => {
    const { text, sources } = await search(stripWith(OWN_SERVER_EMAIL));
    assert.ok(!text.includes(SYNTH_EMAIL), 'the blocked value reached the prompt through the source label');
    assert.ok(text.includes('### Source 1: [blocked:email] — invoice'));
    assert.strictEqual(sources[0].title, `${SYNTH_EMAIL} — invoice`, 'the citation keeps the real title');
});

test('without a strip hook, or with nothing to strip, the label is the title as before', async () => {
    for (const hook of [null, stripWith(null)]) {
        const { text } = await search(hook);
        assert.ok(text.includes(`### Source 1: ${SYNTH_EMAIL} — invoice`));
    }
});

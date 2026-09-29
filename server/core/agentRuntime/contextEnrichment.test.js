/**
 * BFSF-354 — knowledge-base passages an agent turn injects WITHOUT a tool call
 * honour the Privacy Shield's "own server" block list.
 *
 * The same passages fetched through kb_search were stripped in the tool loop,
 * so an agent with that tool honoured the setting and one without it (or a
 * project thread's own bases) did not. Retrieval is stubbed through
 * testUtils/stubRequire; the detector is injected into the real gate.
 * Test data is synthetic.
 *
 * Run: cd server && node --test core/agentRuntime/contextEnrichment.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const SYNTH_EMAIL = 'someone@example.test';
const fx = { quick: [], auto: [] };

const restore = installResolveStub({
    './knowledgeSearch': {
        quickKBSearch: async () => fx.quick,
        // Stands in for the real search (its own side is pinned in
        // knowledgeSearch.shieldLabels.test.js): builds its passages, hands
        // them and their label function to the caller's strip hook, then
        // emits and returns what it would inject under the labels it got back.
        performKnowledgeSearch: async ({ stripPassages, onEvent }) => {
            const chunks = fx.auto.map(c => ({ ...c }));
            const labelOf = c => c.title;
            const labels = (stripPassages && chunks.length) ? await stripPassages(chunks, labelOf) : null;
            onEvent('kb_sources', { sources: chunks.map(c => ({ title: c.title, content: c.content })) });
            return chunks.map((c, i) => `\n### Source ${i + 1}: ${labels ? labels[i] : labelOf(c)}\n${c.content}`).join('');
        },
    },
    './testAs': { visibleKbIdsFor: async (ids) => ids },
});
test.after(() => restore());

const toolPiiGate = require('../privacy/toolPiiGate');
toolPiiGate._deps.detectPii = async (text, categories) => {
    const i = String(text).indexOf(SYNTH_EMAIL);
    if (i < 0 || !categories.includes('Email')) return { hasPii: false, entities: [] };
    return { hasPii: true, entities: [{ text: SYNTH_EMAIL, category: 'Email', label: 'Email Address', offset: i, length: SYNTH_EMAIL.length }] };
};

const { injectProjectAndKnowledgeContext } = require('./contextEnrichment');

const OWN_SERVER_EMAIL = {
    enabled: true,
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
};

function run(over = {}) {
    const kbSources = [];
    const events = [];
    return injectProjectAndKnowledgeContext({
        agent: { id: 'a1', organization_id: 'org1', config: {} },
        userId: 'u1',
        userMessage: 'who handles billing?',
        userAuth: { session: null },
        validProject: null,
        systemPrompt: 'SYS',
        volatileSystemPrompt: 'VOL',
        _kbSources: kbSources,
        onEvent: (type, data) => events.push({ type, data }),
        moderationViolation: false,
        guardrailViolation: false,
        tools: [],
        isStrictKnowledge: false,
        ...over,
    }).then(out => ({ ...out, kbSources, events }));
}

test.beforeEach(() => { fx.quick = []; fx.auto = []; });

test('a project thread: its bases are stripped in the prompt and in the citation snippets', async () => {
    fx.quick = [{ title: 'Billing', content: `billing contact ${SYNTH_EMAIL}`, document_id: 'd1' }];
    const out = await run({
        validProject: { name: 'Acme', knowledgeBaseIds: ['kb1'], customInstructions: '' },
        shield: OWN_SERVER_EMAIL,
    });
    assert.ok(!out.volatileSystemPrompt.includes(SYNTH_EMAIL), 'the blocked value reached the prompt');
    assert.ok(out.volatileSystemPrompt.includes('billing contact [blocked:email]'));
    const snippet = out.kbSources.find(s => s.document_id === 'd1').snippet;
    assert.strictEqual(snippet, 'billing contact [blocked:email]');
});

test('an agent without kb_search: the auto-injected passages are stripped too', async () => {
    fx.auto = [{ title: 'Billing', content: `billing contact ${SYNTH_EMAIL}` }];
    const out = await run({ shield: OWN_SERVER_EMAIL });
    assert.ok(!out.volatileSystemPrompt.includes(SYNTH_EMAIL));
    assert.ok(out.volatileSystemPrompt.includes('billing contact [blocked:email]'));
    const sources = out.events.find(e => e.type === 'kb_sources').data.sources;
    assert.strictEqual(sources[0].content, 'billing contact [blocked:email]');
});

test('no shield: nothing changes', async () => {
    fx.auto = [{ title: 'Billing', content: `billing contact ${SYNTH_EMAIL}` }];
    const out = await run({ shield: null });
    assert.ok(out.volatileSystemPrompt.includes(SYNTH_EMAIL));
});

test('the source label is stripped on both paths, the citation keeps the real title', async () => {
    const title = `${SYNTH_EMAIL} — invoice`;
    fx.quick = [{ title, content: 'the invoice is attached', document_id: 'd1' }];
    fx.auto = [{ title, content: 'the invoice is attached' }];
    const out = await run({
        validProject: { name: 'Acme', knowledgeBaseIds: ['kb1'], customInstructions: '' },
        shield: OWN_SERVER_EMAIL,
    });
    assert.ok(!out.volatileSystemPrompt.includes(SYNTH_EMAIL), 'the blocked value reached the prompt through a source label');
    assert.strictEqual(out.volatileSystemPrompt.split('### Source 1: [blocked:email] — invoice').length - 1, 2, 'project and auto-injected passages');
    assert.strictEqual(out.kbSources.find(s => s.document_id === 'd1').title, title);
});

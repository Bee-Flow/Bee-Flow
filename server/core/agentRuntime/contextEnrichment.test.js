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
const FILES_KB = '22222222-2222-4222-8222-222222222222';
// `hidden`: bases the asker's ordinary filter drops. `searched`: the id lists
// the project door handed to retrieval.
const fx = { quick: [], auto: [], hidden: [], searched: [], kbRows: {} };

const restore = installResolveStub({
    './knowledgeSearch': {
        quickKBSearch: async (_userId, kbIds) => { fx.searched.push([...kbIds]); return fx.quick; },
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
    './testAs': { visibleKbIdsFor: async (ids) => ids.filter(id => !fx.hidden.includes(id)) },
    // Read by core/kb/projectFilesKb.js to verify a project's files base.
    '../../stores/knowledgeBases': { getKB: async (id) => fx.kbRows[id] || null },
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

test.beforeEach(() => { fx.quick = []; fx.auto = []; fx.hidden = []; fx.searched = []; fx.kbRows = {}; });

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

// ── The project's own files base ─────────────────────────────────────
// It is never published, so the ordinary per-asker filter drops it for every
// member but the owner. The project door keeps it for members, and only when
// the id really is this project's files base.

const filesProject = (over = {}) => ({
    id: 'p1', name: 'Acme', customInstructions: '', organizationId: 'org1',
    filesKbId: FILES_KB, knowledgeBaseIds: ['kb1', FILES_KB], ...over,
});

test('a member\'s agent turn searches the project files even though the ordinary filter hides them', async () => {
    fx.hidden = [FILES_KB];
    fx.kbRows[FILES_KB] = { id: FILES_KB, source_kind: 'project_files', organization_id: 'org1' };
    fx.quick = [{ title: 'Plan.pdf', content: 'the launch is in May', document_id: 'd9', kb_id: FILES_KB }];
    const out = await run({ validProject: filesProject() });
    assert.deepStrictEqual(fx.searched, [[FILES_KB, 'kb1']]);
    assert.ok(out.volatileSystemPrompt.includes('the launch is in May'));
});

test('a files id that does not point at this project\'s files base is not searched', async () => {
    fx.hidden = [FILES_KB];
    fx.kbRows[FILES_KB] = { id: FILES_KB, source_kind: 'manual', organization_id: 'org1' };
    await run({ validProject: filesProject() });
    assert.deepStrictEqual(fx.searched, [['kb1']]);
});

test('a "Test as" preview does not search the project files', async () => {
    fx.kbRows[FILES_KB] = { id: FILES_KB, source_kind: 'project_files', organization_id: 'org1' };
    await run({ validProject: filesProject(), testAs: { groupId: 'g1' } });
    assert.deepStrictEqual(fx.searched, [['kb1']]);
});

/**
 * aiAct/signals — what the platform detects about a routine or agent.
 * Run: node --test --test-force-exit server/compliance/aiAct/signals.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

// One recording db double behind every require spelling the graph uses.
const calls = [];
let oneResult = null;
let allResult = [];
const db = {
    getOne: async (sql, params) => { calls.push({ fn: 'getOne', sql, params }); return typeof oneResult === 'function' ? oneResult(sql, params) : oneResult; },
    getAll: async (sql, params) => { calls.push({ fn: 'getAll', sql, params }); return typeof allResult === 'function' ? allResult(sql, params) : allResult; },
    run: async (sql, params) => { calls.push({ fn: 'run', sql, params }); return { rows: [] }; },
    exec: async () => {},
};
let settings = { ai_content_marking_enabled: false };
const complianceStore = { getSettings: async () => settings };

const restore = installResolveStub({
    '../../db': db,
    '../../../db': db,
    '../db': db,
    '../../stores/complianceStore': complianceStore,
});
const signals = require('./signals');
after(() => restore());

const AI_ROUTINE = {
    trigger: { id: 't', kind: 'webhook' },
    steps: [
        { id: 'read', type: 'integration_action', tool: 'drive_read' },
        { id: 'ai_1', type: 'ai_step', label: 'Draft', prompt: 'Write a letter about {{steps.read.output.text}}' },
        { id: 'doc', type: 'generate_document', label: 'Letter', content: '{{steps.ai_1.output.text}}', title: 'Letter' },
    ],
    edges: [],
};

test('step-family detection: ai_step / data_extraction / ai_tool count, summarize does not', () => {
    for (const type of ['ai_step', 'data_extraction', 'ai_tool']) {
        const s = signals.signalsFromDefinition({ steps: [{ id: 'x', type, prompt: 'p' }] });
        assert.strictEqual(s.contains_ai, true, type);
        assert.deepStrictEqual(s.steps.ai.map(x => x.type), [type]);
    }
    const none = signals.signalsFromDefinition({
        steps: [
            { id: 'sum', type: 'summarize', op: 'count' },
            { id: 'doc', type: 'generate_document', content: '{{steps.sum.output.value}}' },
        ],
    });
    assert.strictEqual(none.contains_ai, false);
    assert.strictEqual(none.generates_content, false, 'a document after a summarize is not AI-generated');
    assert.deepStrictEqual(none.steps.ai, []);
});

test('generates_content: template reference is the strongest signal, walk-order downstream the weaker one', () => {
    const s = signals.signalsFromDefinition(AI_ROUTINE);
    assert.strictEqual(s.generates_content, true);
    assert.deepStrictEqual(s.steps.generating.map(g => [g.id, g.signal, g.aiStepIds]), [['doc', 'reference', ['ai_1']]]);

    const downstream = signals.signalsFromDefinition({
        steps: [
            { id: 'ai_1', type: 'ai_tool', prompt: 'p' },
            { id: 'set', type: 'set_variable', value: '{{steps.ai_1.output.text}}' },
            { id: 'doc', type: 'generate_document', content: '{{vars.text}}' },
        ],
    });
    assert.deepStrictEqual(downstream.steps.generating.map(g => [g.id, g.signal]), [['doc', 'downstream']]);

    const before = signals.signalsFromDefinition({
        steps: [
            { id: 'doc', type: 'generate_document', content: 'static' },
            { id: 'ai_1', type: 'ai_step', prompt: 'p' },
        ],
    });
    assert.strictEqual(before.contains_ai, true);
    assert.strictEqual(before.generates_content, false, 'a document BEFORE the AI step cannot carry its output');
});

test('customer_facing: a form trigger, a form_page step, a triggers[] form entry or a live form page row', () => {
    const base = { steps: [{ id: 'ai_1', type: 'ai_step', prompt: 'p' }] };
    assert.strictEqual(signals.signalsFromDefinition(base).customer_facing, false);
    assert.strictEqual(signals.signalsFromDefinition({ ...base, trigger: { kind: 'form', form: {} } }).customer_facing, true);
    assert.strictEqual(signals.signalsFromDefinition({ ...base, trigger: { kind: 'webhook' }, triggers: [{ kind: 'schedule' }, { kind: 'form' }] }).customer_facing, true);
    assert.strictEqual(signals.signalsFromDefinition({ steps: [...base.steps, { id: 'page', type: 'form_page', mode: 'ending' }] }).customer_facing, true);
    assert.strictEqual(signals.signalsFromDefinition(base, { liveFormPages: 2 }).customer_facing, true);
    const withMeta = signals.signalsFromDefinition({ ...base, trigger: { kind: 'form' } }, { liveFormPages: 1 });
    assert.deepStrictEqual(withMeta.surfaces, { form_triggers: 1, form_page_steps: 0, live_form_pages: 1 });
});

test('disclosure_present reuses the Art. 50(1) vocabulary on the ending page and the generated content', () => {
    const { hasDisclosure } = require('../checks/aia/art50-ai-disclosure');
    assert.strictEqual(typeof hasDisclosure, 'function');
    assert.strictEqual(hasDisclosure('This reply was written by an AI assistant.'), true);
    assert.strictEqual(hasDisclosure('Deze brief is gemaakt met kunstmatige intelligentie.'), true);
    assert.strictEqual(hasDisclosure('Kind regards, the team'), false);
    assert.strictEqual(hasDisclosure(null), false);

    const withPage = signals.signalsFromDefinition({
        trigger: { kind: 'form' },
        steps: [
            { id: 'ai_1', type: 'ai_step', prompt: 'p' },
            { id: 'page', type: 'form_page', mode: 'ending', fields: [{ type: 'text', label: 'Thanks — this answer was generated by an AI assistant.' }] },
        ],
    });
    assert.strictEqual(withPage.disclosure_present, true);

    const withDoc = signals.signalsFromDefinition({
        steps: [
            { id: 'ai_1', type: 'ai_step', prompt: 'p' },
            { id: 'doc', type: 'generate_document', content: '{{steps.ai_1.output.text}}\n\nGegenereerd met een AI-model.' },
        ],
    });
    assert.strictEqual(withDoc.disclosure_present, true);
    assert.strictEqual(signals.signalsFromDefinition(AI_ROUTINE).disclosure_present, false);
});

test('annex_iii_hint fires on title, description and AI prompts in NL and EN, with the category', () => {
    const none = signals.signalsFromDefinition(AI_ROUTINE, { title: 'Weekly digest', description: 'Nothing special' });
    assert.strictEqual(none.annex_iii_hint, false);
    assert.deepStrictEqual(none.annex_iii_categories, []);

    const title = signals.signalsFromDefinition(AI_ROUTINE, { title: 'Sollicitanten screenen' });
    assert.strictEqual(title.annex_iii_hint, true);
    assert.deepStrictEqual(title.annex_iii_categories, ['employment']);

    const prompt = signals.signalsFromDefinition({
        steps: [{ id: 'ai_1', type: 'ai_step', prompt: 'Assess the credit worthiness and insurance risk of {{input.name}}' }],
    });
    assert.strictEqual(prompt.annex_iii_hint, true);
    assert.deepStrictEqual(prompt.annex_iii_categories, ['credit', 'insurance']);

    // The description of a non-AI step does not count: only the model sees prompts.
    const other = signals.signalsFromDefinition({
        steps: [{ id: 'n', type: 'notification', text: 'student' }, { id: 'ai_1', type: 'ai_step', prompt: 'p' }],
    });
    assert.strictEqual(other.annex_iii_hint, false);
    assert.deepStrictEqual(signals.annexIiiHint('essentiële nutsvoorzieningen'), { hint: true, categories: ['essential_services'] });
});

test('marking_enabled mirrors the org setting; a string definition is parsed, garbage is empty', () => {
    assert.strictEqual(signals.signalsFromDefinition(AI_ROUTINE, { markingEnabled: true }).marking_enabled, true);
    assert.strictEqual(signals.signalsFromDefinition(JSON.stringify(AI_ROUTINE)).contains_ai, true);
    const empty = signals.signalsFromDefinition('not json');
    assert.deepStrictEqual([empty.contains_ai, empty.customer_facing, empty.generates_content], [false, false, false]);
});

test('signalsFromAgent: always AI + generating, customer_facing = is_published, disclosure on the published prompt', () => {
    const s = signals.signalsFromAgent({ id: 'a1', name: 'Helpdesk', is_published: true, published_system_prompt: 'You are an AI assistant.', system_prompt: 'draft' });
    assert.deepStrictEqual([s.contains_ai, s.generates_content, s.customer_facing, s.disclosure_present], [true, true, true, true]);
    const draft = signals.signalsFromAgent({ id: 'a2', name: 'Recruiter bot', is_published: false, system_prompt: 'Rank the applicants (werving).' });
    assert.deepStrictEqual([draft.customer_facing, draft.disclosure_present, draft.annex_iii_hint], [false, false, true]);
    assert.deepStrictEqual(draft.annex_iii_categories, ['employment']);
});

test('signalsForAutomation scopes through COALESCE(a.organization_id, u."organizationId") and returns null outside the org', async () => {
    calls.length = 0;
    oneResult = null;
    assert.strictEqual(await signals.signalsForAutomation('org-1', 'auto-9'), null);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].sql, /COALESCE\(a\.organization_id, u\."organizationId"\) = \$1/);
    assert.match(calls[0].sql, /JOIN users u ON u\.id = a\.user_id/);
    assert.deepStrictEqual(calls[0].params, ['org-1', 'auto-9']);

    calls.length = 0;
    settings = { ai_content_marking_enabled: true };
    oneResult = { id: 'auto-9', title: 'Kredietaanvraag', description: '', definition_json: JSON.stringify(AI_ROUTINE), live_form_pages: 1 };
    const s = await signals.signalsForAutomation('org-1', 'auto-9');
    assert.deepStrictEqual(
        [s.contains_ai, s.generates_content, s.customer_facing, s.marking_enabled, s.annex_iii_hint],
        [true, true, true, true, true],
    );
    assert.strictEqual(await signals.signalsForAutomation(null, 'auto-9'), null, 'no org → nothing (never a cross-org read)');
});

test('signalsForAgent scopes on agents.organization_id; listGeneratingAutomations keeps only routines with AI-fed documents', async () => {
    calls.length = 0;
    oneResult = { id: 'a1', name: 'Bot', is_published: true, system_prompt: 'I am an AI assistant.' };
    const s = await signals.signalsForAgent('org-1', 'a1');
    assert.match(calls[0].sql, /FROM agents/);
    assert.match(calls[0].sql, /organization_id = \$1/);
    assert.deepStrictEqual(calls[0].params, ['org-1', 'a1']);
    assert.strictEqual(s.disclosure_present, true);

    calls.length = 0;
    allResult = [
        { id: 'a', title: 'With doc', is_active: true, is_draft: false, definition_json: AI_ROUTINE },
        { id: 'b', title: 'Plain', is_active: true, is_draft: false, definition_json: { steps: [{ id: 'doc', type: 'generate_document', content: 'x' }] } },
        { id: 'c', title: 'AI no doc', is_active: false, is_draft: true, definition_json: { steps: [{ id: 'ai', type: 'ai_step' }] } },
    ];
    const list = await signals.listGeneratingAutomations('org-1');
    assert.match(calls[0].sql, /COALESCE\(a\.organization_id, u\."organizationId"\) = \$1/);
    assert.deepStrictEqual(list.map(x => x.id), ['a']);
    assert.deepStrictEqual(list[0].aiStepIds, ['ai_1']);
    assert.deepStrictEqual(list[0].generating.map(g => g.id), ['doc']);
    assert.ok(!('user_id' in list[0]), 'no owner data in the subject list');
    assert.deepStrictEqual(await signals.listGeneratingAutomations(null), []);
});

test('titlesFor looks titles up per kind, org-scoped, and returns nothing else', async () => {
    calls.length = 0;
    allResult = (sql) => /FROM agents/.test(sql)
        ? [{ id: 'ag1', name: 'Helpdesk', organization_id: 'org-1', owner_email: 'x@y.z' }]
        : [{ id: 'au1', title: 'Letters' }];
    const t = await signals.titlesFor('org-1', [
        { target_kind: 'automation', target_id: 'au1' }, { target_kind: 'agent', target_id: 'ag1' }, { target_kind: 'bogus', target_id: 'q' },
    ]);
    assert.deepStrictEqual(t, { automation: { au1: 'Letters' }, agent: { ag1: 'Helpdesk' } });
    assert.strictEqual(calls.length, 2);
    for (const c of calls) assert.strictEqual(c.params[0], 'org-1');
});

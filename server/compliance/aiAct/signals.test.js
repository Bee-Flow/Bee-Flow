/**
 * aiAct/signals — what the platform detects about an automation or agent.
 * Run: node --test server/compliance/aiAct/signals.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');
const { failReads, hideTable } = require('../../testUtils/pgliteFaults');

// The automations, agents, users and form pages are real tables (the boot
// ladder's schema on PGlite behind db.js's pool); only the org settings are stubbed.
const { pg, close } = usePglitePool(ladderPglite());
let settings = { ai_content_marking_enabled: false };
const complianceStore = { getSettings: async () => settings };

const restore = installResolveStub({
    '../../stores/complianceStore': complianceStore,
});
const signals = require('./signals');
after(async () => { restore(); await close(); });

const AI_AUTOMATION = {
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
    const s = signals.signalsFromDefinition(AI_AUTOMATION);
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
    assert.strictEqual(signals.signalsFromDefinition(AI_AUTOMATION).disclosure_present, false);
});

test('annex_iii_hint fires on title, description and AI prompts in NL and EN, with the category', () => {
    const none = signals.signalsFromDefinition(AI_AUTOMATION, { title: 'Weekly digest', description: 'Nothing special' });
    assert.strictEqual(none.annex_iii_hint, false);
    assert.deepStrictEqual(none.annex_iii_categories, []);

    const title = signals.signalsFromDefinition(AI_AUTOMATION, { title: 'Sollicitanten screenen' });
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
    assert.strictEqual(signals.signalsFromDefinition(AI_AUTOMATION, { markingEnabled: true }).marking_enabled, true);
    assert.strictEqual(signals.signalsFromDefinition(JSON.stringify(AI_AUTOMATION)).contains_ai, true);
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

let seeded = null;
const AI_DOC = AI_AUTOMATION;
const seed = () => (seeded ||= (async () => {
    await insertRow(pg, 'users', { id: 'sg-u1', username: 'sg-u1', organizationId: 'org-1' });
    await insertRow(pg, 'users', { id: 'sg-u2', username: 'sg-u2', organizationId: 'org-2' });
    const aut = (/** @type {Record<string, unknown>} */ over) => insertRow(pg, 'automations', {
        user_id: 'sg-u1', definition_json: AI_DOC, is_active: true, is_draft: false, kind: 'automation', ...over,
    });
    // org through the owner (organization_id never stamped) and stamped.
    await aut({ id: 'auto-9', title: 'Kredietaanvraag', description: '' });
    await insertRow(pg, 'automation_form_pages', { id: 'fp-9', automation_id: 'auto-9' });
    await aut({ id: 'a', title: 'With doc', organization_id: 'org-1' });
    await aut({ id: 'b', title: 'Plain', definition_json: { steps: [{ id: 'doc', type: 'generate_document', content: 'x' }] } });
    await aut({ id: 'c', title: 'AI no doc', definition_json: { steps: [{ id: 'ai', type: 'ai_step' }] } });
    await aut({ id: 'theirs', title: 'Other org', user_id: 'sg-u2' });
    await aut({ id: 'trashed', title: 'Trashed', deleted_at: new Date().toISOString() });
    // The live copy is what runs: the working copy lost its AI step since.
    await aut({ id: 'live-ai', title: 'Live AI', definition_json: { steps: [] }, live_definition_json: AI_DOC });
    await aut({ id: 'live-plain', title: 'Live plain', definition_json: AI_DOC, live_definition_json: { steps: [] } });
    await insertRow(pg, 'agents', { id: 'a1', name: 'Bot', owner_id: 'sg-u1', organization_id: 'org-1', is_published: true, system_prompt: 'I am an AI assistant.' });
    await insertRow(pg, 'agents', { id: 'ag1', name: 'Helpdesk', owner_id: 'sg-u1', organization_id: 'org-1', is_published: true, system_prompt: 'x' });
    await insertRow(pg, 'agents', { id: 'ag-theirs', name: 'Theirs', owner_id: 'sg-u2', organization_id: 'org-2', is_published: true, system_prompt: 'x' });
})());

test('signalsForAutomation scopes through the owner\'s organisation and returns null outside the org', async () => {
    await seed();
    assert.strictEqual(await signals.signalsForAutomation('org-2', 'auto-9'), null);
    assert.strictEqual(await signals.signalsForAutomation('org-1', 'missing'), null);
    settings = { ai_content_marking_enabled: true };
    const s = await signals.signalsForAutomation('org-1', 'auto-9');
    assert.deepStrictEqual(
        [s.contains_ai, s.generates_content, s.customer_facing, s.marking_enabled, s.annex_iii_hint],
        [true, true, true, true, true],
        'a live form page makes it customer-facing',
    );
    settings = { ai_content_marking_enabled: false };
    assert.strictEqual(await signals.signalsForAutomation(null, 'auto-9'), null, 'no org → nothing (never a cross-org read)');
});

test('signalsForAgent scopes on agents.organization_id; listGeneratingAutomations keeps only automations with AI-fed documents', async () => {
    await seed();
    const s = await signals.signalsForAgent('org-1', 'a1');
    assert.strictEqual(s.disclosure_present, true);
    assert.strictEqual(await signals.signalsForAgent('org-2', 'a1'), null, 'another org\'s agent is not found');

    const list = await signals.listGeneratingAutomations('org-1');
    assert.deepStrictEqual(list.map((/** @type {any} */ x) => x.id).sort(), ['a', 'auto-9', 'live-ai']);
    const a = list.find((/** @type {any} */ x) => x.id === 'a');
    assert.deepStrictEqual(a.aiStepIds, ['ai_1']);
    assert.deepStrictEqual(a.generating.map((/** @type {any} */ g) => g.id), ['doc']);
    assert.ok(!('user_id' in a), 'no owner data in the subject list');
    assert.deepStrictEqual(await signals.listGeneratingAutomations(null), []);
});

test('titlesFor looks titles up per kind, org-scoped, and returns nothing else', async () => {
    await seed();
    const t = await signals.titlesFor('org-1', [
        { target_kind: 'automation', target_id: 'a' }, { target_kind: 'agent', target_id: 'ag1' }, { target_kind: 'bogus', target_id: 'q' },
        { target_kind: 'agent', target_id: 'ag-theirs' }, { target_kind: 'automation', target_id: 'theirs' },
    ]);
    assert.deepStrictEqual(t, { automation: { a: 'With doc' }, agent: { ag1: 'Helpdesk' } });
});

test('listGeneratingAutomations judges the live copy and leaves trashed automations out', async () => {
    await seed();
    const ids = (await signals.listGeneratingAutomations('org-1')).map((/** @type {any} */ x) => x.id);
    // Scheduled, form and app runs execute live_definition_json; a never-live
    // automation (live NULL) runs its working copy.
    assert.ok(ids.includes('live-ai') && !ids.includes('live-plain'));
    // A trashed automation no longer runs, so it is no Art. 50(2) subject.
    assert.ok(!ids.includes('trashed'));
});

test('loadAutomation does not resolve a trashed automation (no assessment, no attestation)', async () => {
    await seed();
    assert.strictEqual(await signals.loadAutomation('org-1', 'trashed'), null);
    assert.ok(await signals.loadAutomation('org-1', 'a'));
});

test('listGeneratingAutomations throws on a failed read: the Art. 50(2) list retires what it no longer holds', async () => {
    await seed();
    // "could not read" answered as [] would retire every automation's slot.
    const undo = await failReads(pg, 'automations', '57014', 'canceling statement due to statement timeout');
    try {
        await assert.rejects(() => signals.listGeneratingAutomations('org-1'), (/** @type {any} */ e) => e.code === '57014');
    } finally { await undo(); }
    // A missing table (fresh install) is still an empty list.
    const show = await hideTable(pg, 'automations');
    try { assert.deepStrictEqual(await signals.listGeneratingAutomations('org-1'), []); } finally { await show(); }
});

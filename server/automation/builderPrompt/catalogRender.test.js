/**
 * Catalogue rendering — the per-app action cap.
 *
 * The cap used to be 30 while the demo org's `nextcloud` app had 34 actions,
 * and the overflow vanished with no marker. A list that looks complete is how a
 * model concludes an action does not exist and picks a different one, which is
 * the same failure the app filter caused one level up. The cap now sits above
 * any real app AND announces itself when it bites.
 *
 * Run: cd server && node --test --test-force-exit automation/builderPrompt/catalogRender.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    renderCatalogSlim, renderCatalog, renderCatalogLean, emptyCatalogLine, renderDatatablesBlock, renderDocumentsBlock,
    renderAgentsBlock, renderKnowledgeBasesBlock, renderAppEventProvidersBlock, renderPickerBlocks,
} = require('./catalogRender');

const mkApp = (id, count) => ({
    id, label: id, available: true,
    actions: Array.from({ length: count }, (_, i) => ({
        name: `${id}_action_${i}`,
        description: `Does thing ${i}`,
        inputSchema: { properties: { a: { type: 'string' } }, required: ['a'] },
    })),
});

test('a real-sized app renders every action, with no truncation note', () => {
    // 34 = the demo org's `nextcloud` app, the case the old cap of 30 silently cut.
    const out = renderCatalogSlim({ apps: [mkApp('nextcloud', 34)] });
    for (let i = 0; i < 34; i++) {
        assert.ok(out.includes(`nextcloud_action_${i}`), `action ${i} must be listed`);
    }
    assert.ok(!/more .* not listed/.test(out), 'nothing was omitted, so nothing should be announced');
});

test('an app over the cap says so, and points at the way to recover', () => {
    const out = renderCatalogSlim({ apps: [mkApp('huge', 57)] });
    assert.ok(out.includes('huge_action_0'));
    assert.ok(!out.includes('huge_action_56'), 'the cap still applies');
    assert.match(out, /…and 7 more huge actions not listed/);
    assert.ok(out.includes('builder_inspect_tool'),
        'the model must be told how to reach an omitted action, not just that it exists');
});

test('the omitted count is exact, and singular reads correctly', () => {
    const out = renderCatalogSlim({ apps: [mkApp('one-over', 51)] });
    assert.match(out, /…and 1 more one-over action not listed/);
});

test('unavailable apps and empty apps render nothing', () => {
    const hidden = { id: 'nope', label: 'nope', available: false, actions: [{ name: 'nope_do' }] };
    const empty = { id: 'bare', label: 'bare', available: true, actions: [] };
    assert.strictEqual(renderCatalogSlim({ apps: [hidden, empty] }), '');
});

// ── No cap is silent ────────────────────────────────────────────────────
// renderCatalog (the flowlet sub-agent's renderer) cut at 30 and renderCatalogLean
// at 20 with no word about it; nextcloud has 34 actions.

test('renderCatalog (flowlet sub-agent) announces what its cap of 30 cut', () => {
    const out = renderCatalog({ apps: [mkApp('nextcloud', 34)] });
    assert.ok(out.includes('nextcloud_action_29'));
    assert.ok(!out.includes('nextcloud_action_30'));
    assert.match(out, /…and 4 more nextcloud actions not listed/);
    assert.ok(out.includes('builder_inspect_tool'), 'and how to reach one');
    assert.ok(!/more .* not listed/.test(renderCatalog({ apps: [mkApp('small', 30)] })), 'exactly at the cap: nothing to announce');
});

test('renderCatalogLean announces what its cap of 20 cut', () => {
    const out = renderCatalogLean({ apps: [mkApp('nextcloud', 34)] });
    assert.match(out, /…and 14 more nextcloud actions not listed/);
});

test('apps beyond the catalogue cap are counted in every renderer', () => {
    const catalog = { apps: [mkApp('a', 1)], appsOmitted: 3 };
    for (const render of [renderCatalog, renderCatalogLean, renderCatalogSlim]) {
        assert.match(render(catalog), /…and 3 more apps this user can run, not listed here/);
    }
    assert.ok(!/more apps/.test(renderCatalogSlim({ apps: [mkApp('a', 1)] })), 'no marker when nothing was cut');
});

test('an empty catalogue says "none" for none, and "could not read" for a catalogue that failed', () => {
    assert.match(emptyCatalogLine({ apps: [] }), /no integrations connected/);
    const failed = emptyCatalogLine({ apps: [], catalogError: 'registry down' });
    assert.match(failed, /could not be read/);
    assert.doesNotMatch(failed, /no integrations connected/);
});

test('the datatable overflow line points at a mechanism that exists', () => {
    const t = (i) => ({ id: `tbl_${i}`, key: `t${i}`, name: `T${i}`, canWrite: true, columns: [] });
    const out = renderDatatablesBlock(Array.from({ length: 22 }, (_, i) => t(i)));
    assert.match(out, /…and 2 more tables not listed/);
    assert.doesNotMatch(out, /document library/, 'there is no datatable search tool, and the document library is not one');
});

test('the document overflow line names the search tool', () => {
    const d = (i) => ({ id: `doc_${i}`, name: `D${i}`, placeholders: [] });
    const out = renderDocumentsBlock(Array.from({ length: 22 }, (_, i) => d(i)));
    assert.match(out, /…and 2 more documents not listed — builder_search_documents finds them/);
});

// ── The id lists ────────────────────────────────────────────────────────

const AGENT = (over) => ({ id: 'agt_1', name: 'Sales helper', description: 'Answers pricing questions', scope: 'personal', canUse: true, reason: null, ...over });

test('agents: ids, names and descriptions of the agents an automation may use — nothing else', () => {
    const out = renderAgentsBlock({ agents: [AGENT(), AGENT({ id: 'agt_2', name: 'HR bot', scope: 'org', description: null })], agentsError: null });
    assert.match(out, /^## Agents you may use/);
    assert.match(out, /- agt_1 · "Sales helper" · personal · Answers pricing questions/);
    assert.match(out, /- agt_2 · "HR bot" · organisation$/m);
    assert.match(out, /never invented/);
});

test('agents: an agent that cannot run in an automation is not listed, but counted', () => {
    const out = renderAgentsBlock({ agents: [AGENT(), AGENT({ id: 'agt_x', name: 'Secret draft', canUse: false, reason: 'not_published' })], agentsError: null });
    assert.ok(!out.includes('agt_x') && !out.includes('Secret draft'));
    assert.match(out, /1 more agent of this user cannot run inside an automation until published and shared; do not use it/);
});

test('agents: "none", "could not read" and "never asked" are three different renderings', () => {
    const none = renderAgentsBlock({ agents: [], agentsError: null });
    const failed = renderAgentsBlock({ agents: [], agentsError: 'identity unavailable' });
    assert.match(none, /none — this user has no agent an automation may use/);
    assert.match(failed, /could not be read just now/);
    assert.doesNotMatch(failed, /none —/, 'a failed read is not an empty workspace');
    assert.match(failed, /do not tell the user they have none/);
    assert.equal(renderAgentsBlock({}), '');
    assert.equal(renderAgentsBlock({ agents: null }), '');
    assert.equal(renderAgentsBlock(null), '');
    // Only unusable agents: the "none" line, plus the count.
    const onlyDrafts = renderAgentsBlock({ agents: [AGENT({ canUse: false })], agentsError: null });
    assert.match(onlyDrafts, /none —/);
    assert.match(onlyDrafts, /1 more agent/);
});

test('agents: the cap says "and N more" and sends the model to the user, not to a guess', () => {
    const agents = Array.from({ length: 33 }, (_, i) => AGENT({ id: `agt_${i}`, name: `A${i}` }));
    const out = renderAgentsBlock({ agents, agentsError: null });
    assert.ok(out.includes('agt_29') && !out.includes('agt_30'));
    assert.match(out, /…and 3 more agents not listed — ask the user for the agent's name rather than guessing an id/);
});

test('agents: a long description is cut to one line', () => {
    const out = renderAgentsBlock({ agents: [AGENT({ description: `line one\nline two ${'x'.repeat(300)}` })], agentsError: null });
    const row = out.split('\n').find(l => l.startsWith('- agt_1'));
    assert.ok(!row.includes('\n') && row.length < 220, row.length);
    assert.ok(row.endsWith('…'));
});

const KB = (over) => ({ id: 'kb_1', name: 'Handbook', description: 'HR policies', canWrite: true, scope: 'org', ...over });

test('knowledge bases: writable and read-only are told apart, and the knowledge_write rule is stated', () => {
    const out = renderKnowledgeBasesBlock({ knowledgeBases: [KB(), KB({ id: 'kb_2', name: 'Wiki', canWrite: false, scope: 'personal' })], knowledgeBasesError: null });
    assert.match(out, /- kb_1 · "Handbook" · writable · organisation · HR policies/);
    assert.match(out, /- kb_2 · "Wiki" · read-only · personal/);
    assert.match(out, /A knowledge_write step needs a WRITABLE one/);
});

test('knowledge bases: none, could-not-read and never-asked are different renderings', () => {
    assert.match(renderKnowledgeBasesBlock({ knowledgeBases: [], knowledgeBasesError: null }), /none — this user has no knowledge base/);
    const failed = renderKnowledgeBasesBlock({ knowledgeBases: [], knowledgeBasesError: 'store down' });
    assert.match(failed, /could not be read just now/);
    assert.doesNotMatch(failed, /none —/);
    assert.equal(renderKnowledgeBasesBlock({}), '');
});

test('knowledge bases: the cap is announced', () => {
    const kbs = Array.from({ length: 31 }, (_, i) => KB({ id: `kb_${i}`, name: `B${i}` }));
    assert.match(renderKnowledgeBasesBlock({ knowledgeBases: kbs, knowledgeBasesError: null }), /…and 1 more base not listed/);
});

const PROVIDERS = [
    { id: 'gmail', label: 'Gmail', defaultEvent: 'mail.new', events: [{ id: 'mail.new', label: 'New mail', deliverability: 'ok' }, { id: 'mail.starred', label: 'Starred', deliverability: 'connector' }] },
    { id: 'approvals', label: 'Approvals', events: [{ id: 'approval.decided', label: 'Decided' }] },
];

test('app events: THIS user\'s providers with every event, the connector-dependent ones marked', () => {
    const out = renderAppEventProvidersBlock({ appEventProviders: PROVIDERS, appEventProvidersError: null });
    assert.match(out, /^## App events you may use/);
    assert.match(out, /- gmail \(Gmail\): mail\.new, mail\.starred \[needs the connector\]/);
    assert.match(out, /- approvals \(Approvals\): approval\.decided/);
});

test('app events: no truncation without a count, none vs could-not-read vs never-asked', () => {
    const many = [{ id: 'nextcloud', label: 'Nextcloud', events: Array.from({ length: 45 }, (_, i) => ({ id: `ev.${i}` })) }];
    const out = renderAppEventProvidersBlock({ appEventProviders: many, appEventProvidersError: null });
    assert.ok(out.includes('ev.39') && !out.includes('ev.40'));
    assert.match(out, /…and 5 more events/);
    assert.match(renderAppEventProvidersBlock({ appEventProviders: [], appEventProvidersError: null }), /none — no service this user has emits events/);
    const failed = renderAppEventProvidersBlock({ appEventProviders: [], appEventProvidersError: 'x' });
    assert.match(failed, /could not be read just now/);
    assert.doesNotMatch(failed, /none —/);
    assert.equal(renderAppEventProvidersBlock({}), '');
});

test('renderPickerBlocks joins what was asked for and drops what was not', () => {
    assert.equal(renderPickerBlocks({ apps: [] }), '');
    const out = renderPickerBlocks({ agents: [AGENT()], agentsError: null, appEventProviders: PROVIDERS });
    assert.ok(out.indexOf('## Agents you may use') < out.indexOf('## App events you may use'));
    assert.ok(!out.includes('Knowledge bases you may use'));
});

test('the blocks are deterministic: the same lists render the same bytes', () => {
    const catalog = { agents: [AGENT()], agentsError: null, knowledgeBases: [KB()], knowledgeBasesError: null, appEventProviders: PROVIDERS, appEventProvidersError: null };
    assert.equal(renderPickerBlocks(catalog), renderPickerBlocks(structuredClone(catalog)));
});


test('renderDatatablesBlock: requireChoice adds one fixed sentence and the output stays byte-stable', () => {
    const { renderDatatablesBlock } = require('./catalogRender');
    const tables = [{ id: 'tbl_1', key: 'facturen', name: 'Facturen', canWrite: true, columns: [{ key: 'datum', name: 'Datum', type: 'date' }] }];
    const plain = renderDatatablesBlock(tables, { canCreate: true });
    const choice = renderDatatablesBlock(tables, { canCreate: true, requireChoice: true });
    assert.equal(choice, `${plain}\n\nUsing one of these existing tables needs the user's choice unless they named it or the flow already uses it: ask with builder_ask_questions {datatableIds, createLabel}.`);
    assert.equal(renderDatatablesBlock(tables, { canCreate: true, requireChoice: true }), choice, 'byte-stable for the same input');
    assert.equal(renderDatatablesBlock(tables), renderDatatablesBlock(tables, { requireChoice: false }), 'off by default');
    assert.doesNotMatch(renderDatatablesBlock([], { canCreate: true, requireChoice: true }), /needs the user's choice/, 'no tables, nothing to choose');
});

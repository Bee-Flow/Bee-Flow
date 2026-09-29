/**
 * What never leaves this installation.
 *
 * Two of these rules are REGRESSION tests for leaks that were live in shipped
 * code: neither appStudio/templateCapture.js nor automation/portability.js
 * removed approver identities, and templateCapture read knowledge-base ids into
 * `requires` but never took them out of the definition. So sharing an app
 * template or exporting a routine handed one organisation's user ids, group ids
 * and KB ids to another.
 *
 * The last two tests below go through the real capture and export entry points
 * rather than this module, because that is where the leak actually was — a
 * sweep that works but is not called is exactly the shape of the original bug.
 *
 * Run: cd server && node --test projects/packaging/scrub.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    RULES, RULE_WHY, APP_SEAT_FIELDS, APP_SEAT_LISTS, } = require('./scrub');

/**
 * Both sweeps, wrapped so every rule they report is recorded.
 *
 * scrub.js's docblock promised "the test file walks this list and asserts each
 * one both fires and is reported", and that was not true: the tests below name
 * their rules one by one, which is structurally blind to a rule that is
 * MISSING from the file — exactly how `automation.datatable_reference` went
 * unwritten while portability.js swept datatables on its own. The last test in
 * this file closes that: a rule nobody exercises fails the suite.
 */
const scrub = require('./scrub');
const FIRED = new Set();
const record = (fn) => (...args) => {
    const report = fn(...args);
    for (const entry of report) FIRED.add(entry.rule);
    return report;
};
const scrubAppDefinition = record(scrub.scrubAppDefinition);
const scrubAutomationDefinition = record(scrub.scrubAutomationDefinition);

// The allow-list builders return `{ payload, report }` rather than a report, so
// they are wrapped separately — but they feed the SAME coverage set, because a
// rule that fires nowhere is the failure this file exists to catch.
const buildShape = (fn) => (...args) => {
    const result = fn(...args);
    for (const entry of result.report) FIRED.add(entry.rule);
    return result;
};
const captureDatatableShape = buildShape(scrub.captureDatatableShape);
const captureAgentShape = buildShape(scrub.captureAgentShape);
const captureKnowledgeBaseShape = buildShape(scrub.captureKnowledgeBaseShape);
const captureBridgeGrants = buildShape(scrub.captureBridgeGrants);

const rulesOf = (report) => [...new Set(report.map(r => r.rule))].sort();

// ═══ Every rule is named and explained ═══════════════════════════════

test('every rule says why it exists', () => {
    for (const rule of Object.values(RULES)) {
        assert.ok(RULE_WHY[rule], `${rule} has no stated reason`);
        assert.ok(RULE_WHY[rule].length > 40, `${rule}'s reason is too thin to be useful`);
    }
});

// ═══ App definitions ═════════════════════════════════════════════════

test('a routine reference is nulled, and reported so it can be counted', () => {
    const def = { actions: { go: { id: 'go', kind: 'run_automation', automationId: 'aut_live' } } };
    const report = scrubAppDefinition(def);
    assert.strictEqual(def.actions.go.automationId, null);
    assert.deepStrictEqual(rulesOf(report), [RULES.APP_AUTOMATION_REFERENCE]);
    assert.strictEqual(report[0].automationId, 'aut_live');
});

test('EVERY approver seat field is removed — the leak that was live', () => {
    const action = { id: 'ask', kind: 'request_approval', prompt: 'ok?' };
    for (const f of APP_SEAT_FIELDS) action[f] = 'someone-real';
    for (const f of APP_SEAT_LISTS) action[f] = ['u1', 'u2'];

    const def = { actions: { ask: action } };
    const report = scrubAppDefinition(def);

    for (const f of [...APP_SEAT_FIELDS, ...APP_SEAT_LISTS]) {
        assert.strictEqual(action[f], undefined, `${f} still on the action`);
    }
    assert.ok(!JSON.stringify(def).includes('someone-real'));
    assert.strictEqual(report.filter(r => r.rule === RULES.APP_APPROVER_IDENTITY).length,
        APP_SEAT_FIELDS.length + APP_SEAT_LISTS.length);
});

test('the question survives — it is the policy that travels, not the people', () => {
    const def = { actions: { ask: { kind: 'request_approval', prompt: 'Approve the order?', rule: 'quorum', quorumCount: 2, assigneeUserId: 'u1' } } };
    scrubAppDefinition(def);
    assert.strictEqual(def.actions.ask.prompt, 'Approve the order?');
    assert.strictEqual(def.actions.ask.rule, 'quorum', 'the decision rule is policy');
    assert.strictEqual(def.actions.ask.quorumCount, 2);
    assert.strictEqual(def.actions.ask.assigneeUserId, undefined, 'the seat is a person');
});

test('knowledge-base references are emptied wherever they hide', () => {
    const def = {
        screens: [{ sections: [{ children: [{ props: { knowledgeBaseIds: ['kb_a', 'kb_b'] } }] }] }],
        actions: { q: { kind: 'kb_query', knowledgeBaseIds: ['kb_c'] } },
    };
    const report = scrubAppDefinition(def);
    assert.ok(!JSON.stringify(def).includes('kb_a'));
    assert.ok(!JSON.stringify(def).includes('kb_c'));
    assert.strictEqual(report.filter(r => r.rule === RULES.APP_KNOWLEDGE_BASE_REFERENCE).length, 2);
});

test('references are found however deep they nest', () => {
    const def = { a: { b: [{ c: { kind: 'run_automation', automationId: 'x' } }] } };
    scrubAppDefinition(def);
    assert.strictEqual(def.a.b[0].c.automationId, null);
});

test('a clean definition reports nothing and is left alone', () => {
    const def = { actions: { t: { kind: 'toast', message: 'hi' } } };
    const before = JSON.stringify(def);
    assert.deepStrictEqual(scrubAppDefinition(def), []);
    assert.strictEqual(JSON.stringify(def), before);
});

// ═══ Automation definitions ══════════════════════════════════════════

test('every approval seat is removed from root, loops, branches and layers', () => {
    const seats = () => ({ assignee: { userId: 'u1' }, approvers: [{ userId: 'u2' }], escalateTo: { groupId: 'g1' }, finalApprover: { userId: 'u3' } });
    const def = {
        steps: [
            { id: 'root', type: 'approval', prompt: 'q', approval: seats() },
            { id: 'l', type: 'loop', body: [{ id: 'inLoop', type: 'approval', approval: seats() }] },
            { id: 'p', type: 'parallel', branches: [[{ id: 'inBranch', type: 'approval', approval: seats() }]] },
        ],
        layers: { enrich: { steps: [{ id: 'inLayer', type: 'approval', approval: seats() }] } },
    };
    const report = scrubAutomationDefinition(def);

    assert.ok(!JSON.stringify(def).includes('u1'));
    assert.ok(!JSON.stringify(def).includes('g1'));
    const stepIds = [...new Set(report.map(r => r.stepId))].sort();
    assert.deepStrictEqual(stepIds, ['inBranch', 'inLayer', 'inLoop', 'root']);
    assert.strictEqual(report.find(r => r.stepId === 'inLayer').layerKey, 'enrich',
        'the report says which layer, so the warning can too');
});

test('the approval deadline and rule survive — policy, not people', () => {
    const def = { steps: [{ id: 's1', type: 'approval', prompt: 'q', approval: { expiresInHours: 48, rule: 'all', assignee: { userId: 'u1' } } }] };
    scrubAutomationDefinition(def);
    assert.strictEqual(def.steps[0].approval.expiresInHours, 48);
    assert.strictEqual(def.steps[0].approval.rule, 'all');
    assert.strictEqual(def.steps[0].approval.assignee, undefined);
});

test('a saved credential is cleared, not just emptied of its id', () => {
    const def = { steps: [{ id: 's1', type: 'http_request', auth: { connectionId: 'conn_live', kind: 'bearer' } }] };
    const report = scrubAutomationDefinition(def);
    assert.strictEqual(def.steps[0].auth, null, 'the whole auth block goes, not the id alone');
    assert.deepStrictEqual(rulesOf(report), [RULES.AUTOMATION_CONNECTION_REFERENCE]);
});

test('a datatable id is cleared, and the KEY is what survives', () => {
    const def = {
        steps: [
            { id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_orgA', datatableKey: 'invoices' },
            { id: 'l', type: 'loop', body: [{ id: 'inLoop', type: 'datatable', op: 'add_row', datatableId: 'tbl_orgA2' }] },
        ],
        layers: { enrich: { steps: [{ id: 'inLayer', type: 'datatable', op: 'find_rows', datatableId: 'tbl_orgA3', datatableKey: 'contacts' }] } },
    };
    const report = scrubAutomationDefinition(def);

    assert.ok(!JSON.stringify(def).includes('tbl_orgA'), 'no organisation-scoped table id may travel');
    assert.strictEqual(def.steps[0].datatableId, '');
    assert.strictEqual(def.steps[0].datatableKey, 'invoices',
        'the key is the author\'s own slug and is the only thing an import can re-link by');
    assert.strictEqual(def.layers.enrich.steps[0].datatableKey, 'contacts');

    assert.deepStrictEqual(rulesOf(report), [RULES.AUTOMATION_DATATABLE_REFERENCE]);
    assert.deepStrictEqual([...new Set(report.map(r => r.stepId))].sort(), ['inLayer', 'inLoop', 's1']);
    assert.strictEqual(report.find(r => r.stepId === 's1').datatableKey, 'invoices',
        'the report carries the key so the warning can name the table');
    assert.strictEqual(report.find(r => r.stepId === 'inLoop').datatableKey, null,
        'a step with no key says so rather than inventing one');
    assert.strictEqual(report.find(r => r.stepId === 'inLayer').layerKey, 'enrich');
});

test('a datatable step that names no table is left alone', () => {
    const def = { steps: [{ id: 's1', type: 'datatable', op: 'find_rows', datatableId: '', datatableKey: 'invoices' }] };
    assert.deepStrictEqual(scrubAutomationDefinition(def), []);
    assert.strictEqual(def.steps[0].datatableKey, 'invoices');
});

test('an ai_step\'s knowledgeBaseIds are emptied, from root, loops and layers alike (BFSF-410)', () => {
    const def = {
        steps: [
            { id: 's1', type: 'ai_step', prompt: 'Draft a reply.', knowledgeBaseIds: ['kb_orgA_style'] },
            { id: 'l', type: 'loop', body: [{ id: 'inLoop', type: 'ai_step', prompt: 'p', knowledgeBaseIds: ['kb_orgA_2'] }] },
        ],
        layers: { enrich: { steps: [{ id: 'inLayer', type: 'ai_step', prompt: 'p', knowledgeBaseIds: ['kb_orgA_3'] }] } },
    };
    const report = scrubAutomationDefinition(def);

    assert.ok(!JSON.stringify(def).includes('kb_orgA'), 'no organisation-scoped KB id may travel');
    assert.deepStrictEqual(def.steps[0].knowledgeBaseIds, []);
    assert.deepStrictEqual(def.layers.enrich.steps[0].knowledgeBaseIds, []);
    assert.deepStrictEqual(rulesOf(report), [RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE]);
    assert.deepStrictEqual([...new Set(report.map(r => r.stepId))].sort(), ['inLayer', 'inLoop', 's1']);
});

// ── the WRITE side of the same id ───────────────────────────────────────
test('a knowledge_write step does not carry the base it writes to across installs', () => {
    // Worse than the read case if it travelled: on a shared installation the
    // id can name a real base belonging to somebody else, in a step whose
    // whole purpose is to ADD documents to it.
    const def = {
        steps: [
            { id: 'w1', type: 'knowledge_write', knowledgeBaseId: 'kb_orgA', content: '{{steps.a.output.text}}', sourceUri: 'ticket:1' },
            { id: 'l', type: 'loop', body: [{ id: 'inLoop', type: 'knowledge_write', knowledgeBaseId: 'kb_orgA', content: 'x' }] },
        ],
        layers: { enrich: { steps: [{ id: 'inLayer', type: 'knowledge_write', knowledgeBaseId: 'kb_orgA', content: 'x' }] } },
    };
    const report = scrubAutomationDefinition(def);

    assert.ok(!JSON.stringify(def).includes('kb_orgA'), 'no organisation-scoped KB id may travel');
    assert.strictEqual(def.steps[0].knowledgeBaseId, '');
    assert.strictEqual(def.layers.enrich.steps[0].knowledgeBaseId, '');
    assert.deepStrictEqual(rulesOf(report), [RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE]);
    assert.deepStrictEqual([...new Set(report.map(r => r.stepId))].sort(), ['inLayer', 'inLoop', 'w1']);
    // The field distinguishes the two sides, so portability.js can warn about
    // a write in words that say it is a write.
    assert.ok(report.every(r => r.field === 'knowledgeBaseId'));
});

test('everything else on a knowledge_write step survives the export', () => {
    // Only the base is workspace-bound. The text, the title and above all the
    // sourceUri — which is what keeps the step idempotent — are the routine.
    const def = { steps: [{ id: 'w1', type: 'knowledge_write', knowledgeBaseId: 'kb_1', title: 'T', content: '{{steps.a.output.text}}', sourceUri: 'ticket:{{x}}', nearDuplicateStrategy: 'merge' }] };
    scrubAutomationDefinition(def);
    const s = def.steps[0];
    assert.deepStrictEqual(
        { title: s.title, content: s.content, sourceUri: s.sourceUri, nearDuplicateStrategy: s.nearDuplicateStrategy },
        { title: 'T', content: '{{steps.a.output.text}}', sourceUri: 'ticket:{{x}}', nearDuplicateStrategy: 'merge' },
    );
});

test('a knowledge_write step with no base yet is left alone', () => {
    assert.deepStrictEqual(scrubAutomationDefinition({ steps: [{ id: 'w1', type: 'knowledge_write', knowledgeBaseId: '', content: 'x' }] }), []);
});

test('an ai_step with no knowledgeBaseIds is left alone', () => {
    const def = { steps: [{ id: 's1', type: 'ai_step', prompt: 'p', knowledgeBaseIds: [] }] };
    assert.deepStrictEqual(scrubAutomationDefinition(def), []);
});

test('an empty seat list is not reported as a removal', () => {
    const def = { steps: [{ id: 's1', type: 'approval', approval: { approvers: [] } }] };
    assert.deepStrictEqual(scrubAutomationDefinition(def), []);
});

test('malformed input is survived, not thrown over', () => {
    assert.deepStrictEqual(scrubAppDefinition(null), []);
    assert.deepStrictEqual(scrubAppDefinition(undefined), []);
    assert.deepStrictEqual(scrubAppDefinition('not an object'), []);
    assert.deepStrictEqual(scrubAutomationDefinition(null), []);
    assert.deepStrictEqual(scrubAutomationDefinition({ steps: 'not an array' }), []);
});

// ═══ The leaks, through the real entry points ════════════════════════

test('REGRESSION: capturing an app template no longer ships approver ids', () => {
    const { captureTemplate } = require('../../appStudio/templateCapture');
    const result = captureTemplate({
        meta: { title: 'Order desk' },
        definition: {
            schemaVersion: 2,
            meta: { name: 'Order desk' },
            homeScreenId: 'home',
            screens: [{ id: 'home', name: 'Home', sections: [{ id: 'sec', children: [] }] }],
            actions: {
                ask: { kind: 'request_approval', prompt: 'Approve?', assigneeUserId: 'usr_alice', approverUserIds: ['usr_bob'] },
                run: { kind: 'run_automation', automationId: 'aut_live' },
            },
        },
    });
    const wire = JSON.stringify(result);
    assert.ok(!wire.includes('usr_alice'), 'the assignee travelled before this');
    assert.ok(!wire.includes('usr_bob'), 'so did the panel seats');
    assert.ok(!wire.includes('aut_live'));
});

test('REGRESSION: exporting a routine no longer ships approver ids', () => {
    const { buildExport } = require('../../automation/portability');
    const envelope = buildExport({
        id: 'a1', title: 'Release', description: '',
        definition: {
            schemaVersion: 2,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{
                id: 's1', type: 'approval', prompt: 'Ship it?',
                approval: { assignee: { userId: 'usr_carol' }, approvers: [{ groupId: 'grp_finance' }] },
            }],
        },
    });
    const wire = JSON.stringify(envelope);
    assert.ok(!wire.includes('usr_carol'), 'the assignee travelled before this');
    assert.ok(!wire.includes('grp_finance'), 'so did the group seat');
    assert.ok(envelope.warnings.some(w => /approvers are people/.test(w)), 'and the exporter says so');
});

// ═══ The allow-lists: a table, an agent and a knowledge base ═════════
//
// These three are ROWS, not documents. A sweep would list what is dangerous
// today and let a column added next year travel for free, so they are rebuilt
// from a named list instead — and every test below checks the SECOND half of
// that promise: something nobody has heard of does not get through.

test('a table travels as a schema, and its access control does not', () => {
    const { payload, report } = captureDatatableShape({
        id: 'tbl_live', key: 'invoices', name: 'Invoices', description: 'billed',
        rowScope: 'own', retentionDays: 30, retentionField: 'created_at', subjectColumn: 'email',
        lawfulBasis: 'contract', scope: { kind: 'org', id: 'org1' }, ownerUserId: 'usr_a',
        organizationId: 'org1', isPublished: true, sharedGroups: ['g1'], writeMode: 'grants',
    }, { fields: [{ id: 'fld_x', key: 'amount', name: 'Amount', type: 'number' }] });

    assert.deepStrictEqual(payload.columns, [{ key: 'amount', name: 'Amount', type: 'number' }]);
    assert.strictEqual(payload.rowScope, 'own');
    assert.strictEqual(payload.retentionDays, 30, 'a narrower retention protects the recipient');
    assert.strictEqual(payload.lawfulBasis, undefined, 'a legal claim belongs to its own controller');
    assert.strictEqual(payload.ownerUserId, undefined);
    assert.strictEqual(payload.sharedGroups, undefined);
    assert.ok(rulesOf(report).includes(RULES.DATATABLE_GRANTS));
    assert.ok(rulesOf(report).includes(RULES.DATATABLE_GOVERNANCE));
    assert.ok(rulesOf(report).includes(RULES.DATATABLE_TENANT_IDENTITY));
});

test('a column key nobody listed is dropped AND reported', () => {
    const { payload, report } = captureDatatableShape(
        { key: 't', name: 'T', description: '' },
        { fields: [{ id: 'f1', key: 'x', name: 'X', type: 'text', encryptionKeyId: 'kms-123' }] },
    );
    assert.strictEqual(payload.columns[0].encryptionKeyId, undefined);
    const unlisted = report.filter(r => r.rule === RULES.UNLISTED_FIELD);
    assert.ok(unlisted.some(r => r.field === 'encryptionKeyId'),
        'the report is how a new column becomes a decision instead of a default');
});

test('a table with no columns at all is a shell, not a crash', () => {
    assert.deepStrictEqual(captureDatatableShape({ key: 't', name: 'T' }, null).payload.columns, []);
    assert.deepStrictEqual(captureDatatableShape(null, null).payload.columns, []);
});

test('EVERY tool grant comes out acting as viewer, whatever it said', () => {
    const { payload, report } = captureAgentShape({
        name: 'A', config: {
            tools: {
                gmail: { actions: '*', actAs: 'owner', confirm: 'direct' },
                drive: { actions: ['list'], actAs: 'viewer' },
                calendar: { actions: ['read'] },
            },
        },
    });
    for (const app of ['gmail', 'drive', 'calendar']) {
        assert.strictEqual(payload.config.tools[app].actAs, 'viewer', `${app}: never more than its user`);
    }
    assert.strictEqual(payload.config.tools.gmail.actions, '*', 'which actions is design, not authority');
    assert.deepStrictEqual(payload.config.tools.drive.actions, ['list']);
    assert.ok(report.some(r => r.rule === RULES.AGENT_TOOL_AUTHORITY && r.app === 'gmail'));
    assert.ok(!report.some(r => r.rule === RULES.AGENT_TOOL_AUTHORITY && r.app === 'drive'),
        'a grant that was already viewer is not reported as a downgrade');
});

test('an agent config key nobody listed does not travel', () => {
    const { payload, report } = captureAgentShape({
        name: 'A', config: { mcpServers: [{ url: 'https://internal', token: 'LEAK' }], memoryEnabled: true },
    });
    assert.strictEqual(payload.config.mcpServers, undefined);
    assert.strictEqual(payload.config.memoryEnabled, true);
    assert.ok(report.some(r => r.rule === RULES.UNLISTED_FIELD && r.field === 'mcpServers'));
});

test('an agent\'s links and its tenant are reported, never carried', () => {
    const { payload, report } = captureAgentShape({
        name: 'A', owner_id: 'usr_a', organization_id: 'org1', is_published: true,
        shared_groups: ['g1'], embed_enabled: true, category_id: 'cat', rev: 4,
        published_config: { x: 1 },
        config: { enabledIntegrations: ['gmail'], knowledge_base_ids: ['kb1'], attachedSkillIds: ['s1'] },
    });
    const wire = JSON.stringify(payload);
    for (const canary of ['usr_a', 'org1', 'g1', 'cat', 'kb1', 's1']) {
        assert.ok(!wire.includes(canary), `${canary} does not travel`);
    }
    assert.strictEqual(payload.embedEnabled, undefined);
    assert.ok(rulesOf(report).includes(RULES.AGENT_ENABLED_INTEGRATIONS));
    assert.ok(rulesOf(report).includes(RULES.AGENT_RESOURCE_REFERENCE));
    assert.ok(rulesOf(report).includes(RULES.AGENT_TENANT_IDENTITY));
});

test('an agent reads both spellings of a column and writes exactly one', () => {
    const { payload } = captureAgentShape({
        name: 'A', system_prompt: 'be brief', starter_prompts: ['hi'], workspace_enabled: true, copy_enabled: false,
    });
    assert.strictEqual(payload.systemPrompt, 'be brief');
    assert.deepStrictEqual(payload.starterPrompts, ['hi']);
    assert.strictEqual(payload.workspaceEnabled, true);
    assert.strictEqual(payload.copyEnabled, false);
    assert.strictEqual(payload.system_prompt, undefined, 'one name for one fact');
});

test('a knowledge base travels as a shell and says its documents stayed', () => {
    const { payload, report } = captureKnowledgeBaseShape({
        id: 'kb1', name: 'Handbook', description: 'how we work', icon: '📘',
        usage_contexts: '["chat","agent"]',
        tenant_id: 'usr_a', organization_id: 'org1', category_id: 'cat', is_published: true,
        documentCount: 12,
    });
    assert.deepStrictEqual(Object.keys(payload).sort(), ['description', 'icon', 'name', 'usageContexts']);
    assert.deepStrictEqual(payload.usageContexts, ['chat', 'agent'], 'a stringified column is parsed, not carried raw');
    assert.ok(rulesOf(report).includes(RULES.KNOWLEDGE_BASE_CONTENT));
    assert.ok(rulesOf(report).includes(RULES.KNOWLEDGE_BASE_TENANT_IDENTITY));
    assert.ok(report.some(r => r.rule === RULES.UNLISTED_FIELD && r.field === 'documentCount'));
});

test('bridge grants are rebuilt, not patched — the spread carried everything', () => {
    const { payload, report } = captureBridgeGrants({
        ai: { enabled: true, publicEnabled: true },
        automations: [{ automationId: 'aut_elsewhere', label: 'Run', seat: 'LEAK' }, { automationId: { $ref: 'aut_1' } }],
        integrations: [{ tool: 'upload', label: 'Up', fixedArgs: { token: 'LEAK' } }],
    });
    assert.strictEqual(payload.ai, undefined, 'the whole ai block goes; install writes the store default');
    assert.deepStrictEqual(payload.automations[0], { automationId: null, label: 'Run' });
    assert.deepStrictEqual(payload.automations[1], { automationId: { $ref: 'aut_1' } },
        'an in-bundle $ref must survive, or the Blueprint installs inert');
    assert.deepStrictEqual(payload.integrations[0], { tool: 'upload', label: 'Up' });
    assert.ok(!JSON.stringify(payload).includes('LEAK'));
    assert.ok(rulesOf(report).includes(RULES.WEBPAGE_PUBLIC_AI));
    assert.ok(rulesOf(report).includes(RULES.WEBPAGE_BRIDGE_ARGUMENTS));
});

test('malformed rows are survived, not thrown over', () => {
    assert.ok(captureDatatableShape(null, null).payload);
    assert.ok(captureAgentShape(undefined).payload);
    assert.ok(captureKnowledgeBaseShape('nonsense').payload);
    assert.deepStrictEqual(captureBridgeGrants(null).payload, { automations: [], integrations: [] });
});

// ═══ The promise this file's header makes ════════════════════════════

test('every rule in RULES actually fires somewhere in this file', () => {
    // The header has promised this since the module was written, and the test
    // was never there — which is precisely how `automation.datatable_reference`
    // went unwritten while portability.js swept datatables on its own. A rule
    // nobody exercises is a rule nobody has checked.
    const never = Object.values(RULES).filter(rule => !FIRED.has(rule));
    assert.deepStrictEqual(never, [], `these rules never fired: ${never.join(', ')}`);
});

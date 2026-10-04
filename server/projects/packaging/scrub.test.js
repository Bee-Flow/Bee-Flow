/**
 * What never leaves this installation.
 *
 * Two of these rules are REGRESSION tests for leaks that were live in shipped
 * code: neither appStudio/templateCapture.js nor automation/portability.js
 * removed approver identities, and templateCapture read knowledge-base ids into
 * `requires` but never took them out of the definition. So sharing an app
 * template or exporting an automation handed one organisation's user ids, group ids
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

// The skill and document-template allow-lists live in capture.js (they need the ref
// map); they feed the same coverage set.
const capture = require('./capture');
const record2 = (fn) => (...args) => {
    const result = fn(...args);
    for (const entry of result.report) FIRED.add(entry.rule);
    return result;
};
const captureSkillShape = record2(capture.captureSkillShape);
const captureDocumentShape = record2(capture.captureDocumentShape);

const rulesOf = (report) => [...new Set(report.map(r => r.rule))].sort();

// ═══ Every rule is named and explained ═══════════════════════════════

test('every rule says why it exists', () => {
    for (const rule of Object.values(RULES)) {
        assert.ok(RULE_WHY[rule], `${rule} has no stated reason`);
        assert.ok(RULE_WHY[rule].length > 40, `${rule}'s reason is too thin to be useful`);
    }
});

// ═══ App definitions ═════════════════════════════════════════════════

test('an automation reference is nulled, and reported so it can be counted', () => {
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
    // sourceUri — which is what keeps the step idempotent — are the automation.
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

test('REGRESSION: exporting an automation no longer ships approver ids', () => {
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
    assert.deepStrictEqual(captureBridgeGrants(null).payload, { automations: [], integrations: [] }, 'no tables key unless the page has one');
    assert.strictEqual(captureAppDataModel(null), null);
});

// ═══ Holes → binding slots, and pipeline mode (design 2, 4.1) ═══════

const captureAppDataModel = (model, report = [], opts = {}) => {
    const out = scrub.captureAppDataModel(model, report, opts);
    for (const entry of report) FIRED.add(entry.rule);
    return out;
};
const captureWebpageKnowledgeBases = (ids, report = [], opts = {}) => {
    const out = scrub.captureWebpageKnowledgeBases(ids, report, opts);
    for (const entry of report) FIRED.add(entry.rule);
    return out;
};
const pipe = (ref, extra = {}) => ({ ref, pipeline: true, slots: [], findings: [], ...extra });
const gallery = (ref) => ({ ref, pipeline: false, slots: [], findings: [] });

test('pipeline: a panel + escalateTo + finalApprover step yields ONE seats slot with the full shape', () => {
    const approval = {
        approvers: [{ userId: 'usr_a' }, { groupId: 'grp_b' }], rule: 'quorum', quorum: 2,
        escalateTo: { userId: 'usr_boss' }, escalateAfterHours: 24,
        finalApprover: { userId: 'usr_cfo' }, expiresInHours: 72,
    };
    const def = { steps: [{ id: 's1', type: 'approval', prompt: 'Ship?', approval: { ...approval } }] };
    const opts = pipe('aut_1');
    scrub.liftAutomationHoles(def, opts);

    assert.deepStrictEqual(opts.slots, [{
        slot: 'seats:aut_1:s1', kind: 'approver_seats', ref: 'aut_1', stepId: 's1', label: 'Who approves',
        suggested: {
            approvers: approval.approvers, escalateTo: approval.escalateTo,
            finalApprover: approval.finalApprover, rule: 'quorum', quorum: 2,
        },
    }]);
    const left = def.steps[0].approval;
    for (const f of ['approvers', 'escalateTo', 'finalApprover', 'rule', 'quorum']) assert.strictEqual(left[f], undefined, f);
    assert.strictEqual(left.expiresInHours, 72, 'the deadline is policy and stays');
    assert.strictEqual(left.escalateAfterHours, 24, 'and so is the escalation clock');
});

test('pipeline: a stage chain travels inside the seat shape', () => {
    const stages = [{ key: 'lead', approvers: [{ userId: 'usr_a' }] }, { key: 'fin', approvers: [{ groupId: 'grp_f' }], rule: 'all' }];
    const def = { steps: [{ id: 's1', type: 'approval', approval: { stages } }] };
    const opts = pipe('aut_1');
    scrub.liftAutomationHoles(def, opts);
    assert.deepStrictEqual(opts.slots[0].suggested, { stages });
    assert.strictEqual(def.steps[0].approval.stages, undefined);
});

test('gallery: approval seats are not lifted into a slot (the scrub clears them as before)', () => {
    const def = { steps: [{ id: 's1', type: 'approval', approval: { assignee: { userId: 'usr_a' } } }] };
    const opts = gallery('aut_1');
    scrub.liftAutomationHoles(def, opts);
    assert.deepStrictEqual(opts.slots, []);
    assert.deepStrictEqual(def.steps[0].approval.assignee, { userId: 'usr_a' }, 'gallery mode mutates nothing');
});

test('pipeline: notificationSettings recipients and Talk rooms become a notify slot', () => {
    const def = {
        steps: [],
        notificationSettings: {
            onError: { enabled: true, channels: ['bell'], recipients: [{ type: 'owner' }, { type: 'user', id: 'usr_ops' }] },
            onApproval: { enabled: true, channels: ['talk'], recipients: [{ type: 'approver' }], talkRoom: 'room_fin' },
            onSuccess: { enabled: false, channels: ['bell'], recipients: [{ type: 'group', id: 'grp_team' }] },
        },
    };
    const opts = pipe('aut_1');
    scrub.liftAutomationHoles(def, opts);
    assert.deepStrictEqual(opts.slots, [{
        slot: 'notify:aut_1', kind: 'approver_seats', ref: 'aut_1', label: 'Who is notified',
        suggested: {
            onError: { recipients: [{ type: 'user', id: 'usr_ops' }] },
            onApproval: { talkRoom: 'room_fin' },
            onSuccess: { recipients: [{ type: 'group', id: 'grp_team' }] },
        },
    }]);
    assert.deepStrictEqual(def.notificationSettings.onError.recipients, [{ type: 'owner' }], 'owner stays');
    assert.deepStrictEqual(def.notificationSettings.onApproval.recipients, [{ type: 'approver' }], 'approver stays');
    assert.strictEqual(def.notificationSettings.onApproval.talkRoom, undefined);
    assert.ok(!JSON.stringify(def).includes('usr_ops'));
});

test('an out-of-bundle pointer becomes a slot; an in-bundle $ref does not', () => {
    const def = {
        steps: [
            { id: 's1', type: 'datatable', datatableId: 'tbl_elsewhere', datatableKey: 'customers' },
            { id: 's2', type: 'datatable', datatableId: { $ref: 'dt_1' }, datatableKey: 'orders' },
            { id: 's3', type: 'ai_step', knowledgeBaseIds: ['kb_out', { $ref: 'kb_1' }] },
            { id: 's4', type: 'http_request', auth: { connectionId: 'conn_dev', kind: 'bearer' }, cacheInto: { datatableId: 'tbl_cache', ttlSeconds: 60 } },
        ],
    };
    const opts = pipe('aut_1', { connSlots: new Map([['conn_dev', 'cn_1']]) });
    scrub.liftAutomationHoles(def, opts);
    assert.deepStrictEqual(opts.slots.map(x => [x.slot, x.kind, x.suggested]), [
        ['table:customers', 'table', { datatableId: 'tbl_elsewhere' }],
        ['kb:aut_1:knowledgeBaseIds:s3', 'knowledge_base', { kbIds: ['kb_out'] }],
        ['connection:cn_1', 'connection', { connectionId: 'conn_dev' }],
        ['table:aut_1:cacheInto:s4', 'table', { datatableId: 'tbl_cache' }],
    ]);
    assert.strictEqual(def.steps[0].datatableId, '');
    assert.deepStrictEqual(def.steps[1].datatableId, { $ref: 'dt_1' });
    assert.deepStrictEqual(def.steps[2].knowledgeBaseIds, [{ $ref: 'kb_1' }]);
    assert.deepStrictEqual(def.steps[3].auth, { connectionId: null, kind: 'bearer' }, 'the rest of auth stays for the binding');
    assert.deepStrictEqual(def.steps[3].cacheInto, { datatableId: null, ttlSeconds: 60 });
});

test('a connection without a ledger slot falls back to connection:<ref>:<stepId>; gallery carries no Dev value', () => {
    const def = { steps: [{ id: 's9', type: 'http_request', auth: { connectionId: 'conn_dev' } }] };
    const opts = gallery('aut_2');
    scrub.liftAutomationHoles(def, opts);
    assert.strictEqual(opts.slots[0].slot, 'connection:aut_2:s9');
    assert.strictEqual(opts.slots[0].suggested, null, 'a gallery file never carries the credential id');
    assert.strictEqual(def.steps[0].auth.connectionId, 'conn_dev', 'gallery: the sweep clears it, not the lift');
});

test('the gallery scrub keeps in-bundle KB refs and drops only the raw ids', () => {
    const def = { steps: [{ id: 's', type: 'ai_step', knowledgeBaseIds: ['kb_x', { $ref: 'kb_1' }] }] };
    scrubAutomationDefinition(def);
    assert.deepStrictEqual(def.steps[0].knowledgeBaseIds, [{ $ref: 'kb_1' }]);
    const app = { actions: { q: { kind: 'kb_query', knowledgeBaseIds: [{ $ref: 'kb_1' }, 'kb_y'] } } };
    scrubAppDefinition(app);
    assert.deepStrictEqual(app.actions.q.knowledgeBaseIds, [{ $ref: 'kb_1' }]);
});

test('pipeline: an app request_approval action yields one seats slot', () => {
    const def = { actions: { ask: { kind: 'request_approval', prompt: 'ok?', approverUserIds: ['usr_a'], finalApproverGroupId: 'grp_f', rule: 'all' } } };
    const opts = pipe('app_1');
    scrub.liftAppHoles(def, opts);
    assert.deepStrictEqual(opts.slots, [{
        slot: 'seats:app_1:actions.ask', kind: 'approver_seats', ref: 'app_1', actionId: 'actions.ask', label: 'Who approves',
        suggested: { finalApproverGroupId: 'grp_f', approverUserIds: ['usr_a'], rule: 'all' },
    }]);
    assert.deepStrictEqual(Object.keys(def.actions.ask).sort(), ['kind', 'prompt']);
});

test('pipeline: fill_document names a template outside the Solution, so it is a doc slot', () => {
    const def = { steps: [{ id: 'd', type: 'fill_document', documentId: 'doc_dev', documentVersionId: 'v3', values: {} }] };
    const opts = pipe('aut_1');
    scrub.liftAutomationHoles(def, opts);
    assert.deepStrictEqual(opts.slots[0].suggested, { documentId: 'doc_dev', documentVersionId: 'v3' });
    assert.strictEqual(def.steps[0].documentId, '');
    assert.strictEqual(def.steps[0].documentVersionId, undefined);
});

test('pipeline: an ai_step skill outside the Solution is a blocking finding', () => {
    const opts = pipe('aut_1');
    scrub.liftAutomationHoles({ steps: [{ id: 's', type: 'ai_step', skillIds: ['skl_dev'] }] }, opts);
    assert.deepStrictEqual(opts.findings.map(f => [f.code, f.severity]), [['automation.skill_not_in_solution', 'blocking']]);
});

test('datatable column ids and the lawful basis are kept only in pipeline mode', () => {
    const table = { key: 'inv', name: 'Invoices', lawfulBasis: 'contract' };
    const meta = { fields: [{ id: 'fld_a', key: 'amount', name: 'Amount', type: 'number' }] };
    const gal = captureDatatableShape(table, meta, []);
    assert.strictEqual(gal.payload.columns[0].id, undefined);
    assert.strictEqual(gal.payload.lawfulBasis, undefined);
    const pip = captureDatatableShape(table, meta, [], { pipeline: true });
    assert.strictEqual(pip.payload.columns[0].id, 'fld_a');
    assert.strictEqual(pip.payload.lawfulBasis, 'contract');
    assert.ok(!pip.report.some(r => r.rule === RULES.DATATABLE_GOVERNANCE), 'same controller: nothing to report');
});

test('the agent keeps its KB and skill refs, avatar and persona in pipeline mode only', () => {
    const agent = {
        name: 'Desk', avatar: '/a.png', persona: { mode: 'free', freeText: 'hi' },
        config: { knowledge_base_ids: [{ $ref: 'kb_1' }, 'kb_out'], attachedSkillIds: [{ $ref: 'skl_1' }, 'skl_out'] },
    };
    const opts = pipe('agt_1');
    const { payload } = captureAgentShape(agent, [], opts);
    assert.deepStrictEqual(payload.config.knowledge_base_ids, [{ $ref: 'kb_1' }]);
    assert.deepStrictEqual(payload.config.attachedSkillIds, [{ $ref: 'skl_1' }]);
    assert.strictEqual(payload.avatar, '/a.png');
    assert.deepStrictEqual(payload.persona, { mode: 'free', freeText: 'hi' });
    assert.deepStrictEqual(opts.slots.map(x => [x.slot, x.suggested]), [['kb:agt_1:knowledge_base_ids:agent', { kbIds: ['kb_out'] }]]);
    assert.deepStrictEqual(opts.findings.map(f => f.code), ['agent.skill_not_in_solution']);

    const gal = captureAgentShape(agent, []);
    assert.strictEqual(gal.payload.config.knowledge_base_ids, undefined);
    assert.strictEqual(gal.payload.config.attachedSkillIds, undefined);
    assert.strictEqual(gal.payload.avatar, undefined);
    assert.strictEqual(gal.payload.persona, undefined);
});

test('page table grants travel as $ref; one outside the bundle is dropped (gallery) or a slot (pipeline)', () => {
    const grants = { automations: [], tables: [
        { datatableId: { $ref: 'dt_1' }, mode: 'readwrite', columns: ['a', 'b'], publicColumns: ['a'] },
        { datatableId: 'tbl_elsewhere', mode: 'read', columns: ['x'] },
    ] };
    const gal = captureBridgeGrants(grants, [], gallery('web_1'));
    assert.deepStrictEqual(gal.payload.tables, [{ datatableId: { $ref: 'dt_1' }, mode: 'readwrite', columns: ['a', 'b'], publicColumns: ['a'] }]);
    assert.ok(gal.report.some(r => r.rule === RULES.WEBPAGE_RESOURCE_REFERENCE));

    const opts = pipe('web_1');
    const pip = captureBridgeGrants(grants, [], opts);
    assert.deepStrictEqual(pip.payload.tables[1], { datatableId: null, mode: 'read', columns: ['x'], publicColumns: [] });
    assert.deepStrictEqual(opts.slots.map(x => x.slot), ['table:web_1:bridgeTables:1']);
});

test('page knowledge bases: $refs travel, a base outside the bundle is a hole', () => {
    const report = [];
    assert.deepStrictEqual(captureWebpageKnowledgeBases([{ $ref: 'kb_1' }, 'kb_out'], report, gallery('web_1')), [{ $ref: 'kb_1' }]);
    assert.ok(report.some(r => r.rule === RULES.WEBPAGE_RESOURCE_REFERENCE && r.field === 'knowledgeBaseIds'));
});

test('an app data model travels as shape; outside tables and group mappings are holes', () => {
    const model = {
        tables: [
            { id: 'tbl_app1', key: 'orders', source: { kind: 'datatable', datatableId: { $ref: 'dt_1' }, mode: 'read' }, fields: [] },
            { id: 'tbl_app2', key: 'leads', source: { kind: 'datatable', datatableId: 'tbl_elsewhere', mode: 'read' }, fields: [] },
        ],
        roleMapping: { default: 'viewer', byGroup: { grp_sales: 'editor' } },
    };
    const report = [];
    const out = captureAppDataModel(model, report, gallery('app_1'));
    assert.deepStrictEqual(out.tables[0].source.datatableId, { $ref: 'dt_1' });
    assert.strictEqual(out.tables[1].source.datatableId, null);
    assert.deepStrictEqual(out.roleMapping.byGroup, {});
    assert.strictEqual(report.filter(r => r.rule === RULES.APP_DATA_MODEL_REFERENCE).length, 2);
    assert.strictEqual(model.tables[1].source.datatableId, 'tbl_elsewhere', 'a new model, the input untouched');

    const opts = pipe('app_1');
    const pip = captureAppDataModel(model, [], opts);
    assert.deepStrictEqual(pip.roleMapping.byGroup, { grp_sales: 'editor' }, 'same organisation: the mapping holds');
    assert.deepStrictEqual(opts.slots.map(x => [x.slot, x.suggested]), [['table:app_1:source:leads', { datatableId: 'tbl_elsewhere' }]]);
});

// ═══ Skills and document templates ═══════════════════════════════════

const SKILL_ROW = {
    id: 'skl_live', orgId: 'org1', userId: 'usr_alice', name: 'Tone', description: 'd', instructions: 'Be brief.',
    isShared: true, sharedGroups: ['grp_x'], enabledIntegrations: ['gmail'], projectId: 'p1', version: 3,
    knowledgeBaseIds: ['kb_in', 'kb_out'], allowedAutomationIds: ['aut_out'], automationId: 'aut_in', mcpServers: ['LEAK'],
};

test('a skill: its resources outside the bundle are dropped and named, the in-bundle ones become $ref', () => {
    const refs = new Map([['kb_in', 'kb_1'], ['aut_in', 'aut_1']]);
    const { payload, integrations, report } = captureSkillShape(SKILL_ROW, refs, []);
    assert.deepStrictEqual(payload.knowledge_base_ids, [{ $ref: 'kb_1' }]);
    assert.deepStrictEqual(payload.allowed_automation_ids, []);
    assert.deepStrictEqual(payload.automation_id, { $ref: 'aut_1' });
    assert.deepStrictEqual(report.filter(r => r.rule === RULES.SKILL_RESOURCE_REFERENCE).map(r => [r.field, r.count]),
        [['knowledge_base_ids', 1], ['allowed_automation_ids', 1]]);
    assert.deepStrictEqual(integrations, ['gmail']);
    assert.ok(!JSON.stringify(payload).includes('kb_out'));
});

test('a skill: owner, organisation, sharing and enabled apps are reported as tenant identity, and an unlisted key as unlisted', () => {
    const { payload, report } = captureSkillShape(SKILL_ROW, new Map(), []);
    const fields = report.filter(r => r.rule === RULES.SKILL_TENANT_IDENTITY).map(r => r.field).sort();
    assert.deepStrictEqual(fields, ['enabledIntegrations', 'isShared', 'orgId', 'projectId', 'sharedGroups', 'userId']);
    assert.ok(report.some(r => r.rule === RULES.UNLISTED_FIELD && r.field === 'mcpServers'));
    for (const key of ['orgId', 'userId', 'isShared', 'sharedGroups', 'enabledIntegrations', 'enabled_integrations', 'mcpServers', 'id', 'projectId']) {
        assert.ok(!(key in payload), `${key} does not travel`);
    }
});

test('a skill outside the Solution is a blocking finding only in a release', () => {
    const findings = [];
    captureSkillShape(SKILL_ROW, new Map(), [], { pipeline: true, ref: 'skl_1', findings });
    assert.deepStrictEqual(findings.map(f => [f.code, f.severity, f.ref, f.field]), [
        ['skill.resource_not_in_solution', 'blocking', 'skl_1', 'knowledge_base_ids'],
        ['skill.resource_not_in_solution', 'blocking', 'skl_1', 'allowed_automation_ids'],
        ['skill.resource_not_in_solution', 'blocking', 'skl_1', 'automation_id'],
    ]);
    const gallery = [];
    captureSkillShape(SKILL_ROW, new Map(), [], { ref: 'skl_1', findings: gallery });
    assert.deepStrictEqual(gallery, []);
});

test('a document template: placement, sharing and what its author typed do not travel', () => {
    const doc = {
        id: 'doc_live', userId: 'u', organizationId: 'o', name: 'Offer', docType: 'presentation', kind: 'section', description: 'x',
        bodyHtml: '<p>b</p>', css: '.c{}', visibility: 'team', folderId: 'f', categories: ['c'], archived: false, versionId: 'v',
        settings: { margin: 1, sampleValues: { a: 'LEAK' }, sectionOverrides: { b: 'LEAK' }, resolvedHouseStyleCss: 'body{}' }, extra: 1,
    };
    const { payload, report } = captureDocumentShape(doc, []);
    assert.deepStrictEqual(payload, {
        name: 'Offer', doc_type: 'presentation', kind: 'section', description: 'x', body_html: '<p>b</p>', css: '.c{}', settings: { margin: 1 },
    });
    assert.deepStrictEqual(report.filter(r => r.rule === RULES.DOCUMENT_TENANT_IDENTITY).map(r => r.field).sort(), [
        'categories', 'folderId', 'organizationId', 'settings.resolvedHouseStyleCss', 'settings.sampleValues',
        'settings.sectionOverrides', 'userId', 'visibility',
    ]);
    assert.ok(report.some(r => r.rule === RULES.UNLISTED_FIELD && r.field === 'extra'));
    assert.deepStrictEqual(doc.settings.sampleValues, { a: 'LEAK' }, 'the source row is not mutated');
    const piped = captureDocumentShape(doc, [], { pipeline: true }).payload;
    assert.deepStrictEqual(piped.settings, { margin: 1, resolvedHouseStyleCss: 'body{}' });
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

// ═══ Review fixes: unique app addresses, legacy Talk room, connection hosts, page agent ═══

test('pipeline: two id-less request_approval steps in one action are two distinct slots', () => {
    const ask = (user) => ({ kind: 'request_approval', approverUserIds: [user] });
    const def = {
        actions: {
            act_x: {
                id: 'act_x', kind: 'flow',
                steps: [ask('usr_a'), { kind: 'condition', branches: [{ steps: [ask('usr_b')] }, { steps: [ask('usr_c')] }] }],
            },
        },
    };
    const opts = pipe('app_1');
    scrub.liftAppHoles(def, opts);
    assert.deepStrictEqual(opts.slots.map(x => [x.slot, x.suggested.approverUserIds[0]]), [
        ['seats:app_1:act_x.steps[0]', 'usr_a'],
        ['seats:app_1:act_x.steps[1].branches[0].steps[0]', 'usr_b'],
        ['seats:app_1:act_x.steps[1].branches[1].steps[0]', 'usr_c'],
    ]);
    assert.strictEqual(new Set(opts.slots.map(x => x.actionId)).size, 3);
});

test('two id-less ai_chat components with different bases are two distinct kb slots', () => {
    const def = { screens: [{ id: 'scr_1', sections: [{ kind: 'ai_chat', props: { knowledgeBaseIds: ['kb_a'] } }, { kind: 'ai_chat', props: { knowledgeBaseIds: ['kb_b'] } }] }] };
    const opts = pipe('app_1');
    scrub.liftAppHoles(def, opts);
    assert.deepStrictEqual(opts.slots.map(x => [x.slot, x.suggested.kbIds]), [
        ['kb:app_1:knowledgeBaseIds:scr_1.sections[0].props', ['kb_a']],
        ['kb:app_1:knowledgeBaseIds:scr_1.sections[1].props', ['kb_b']],
    ]);
});

test('every request_approval in the real invoice-approvals template gets its own seat slot', () => {
    const def = JSON.parse(JSON.stringify(require('../../appStudio/templates/appInvoiceApprovals').definition));
    let n = 0;
    const seed = (node) => {
        if (Array.isArray(node)) { node.forEach(seed); return; }
        if (!node || typeof node !== 'object') return;
        if (node.kind === 'request_approval') { n += 1; node.approverUserIds = [`usr_${n}`]; }
        Object.values(node).forEach(seed);
    };
    seed(def);
    const opts = pipe('app_1');
    scrub.liftAppHoles(def, opts);
    const seats = opts.slots.filter(x => x.kind === 'approver_seats');
    assert.ok(n > 1, 'the template has several approval actions');
    assert.strictEqual(seats.length, n);
    assert.strictEqual(new Set(seats.map(x => x.slot)).size, n, 'no two seat slots share a name');
});

test('pipeline: the legacy per-event ncTalkRoom is lifted into talkRoom and leaves the definition', () => {
    const { normalizeNotificationSettings } = require('../../automation/notificationDefaults');
    const def = {
        steps: [],
        notificationSettings: {
            onApproval: { enabled: true, level: 'heads_up', channels: ['inapp', 'nc_talk'], ncTalkRoom: 'dev-room' },
            onError: { enabled: true, recipients: [{ type: 'owner' }], talkRoom: 'new-room', ncTalkRoom: 'old-room' },
        },
    };
    const opts = pipe('aut_1');
    scrub.liftAutomationHoles(def, opts);
    assert.deepStrictEqual(opts.slots[0].suggested, { onError: { talkRoom: 'new-room' }, onApproval: { talkRoom: 'dev-room' } });
    assert.ok(!JSON.stringify(def).includes('room'), 'neither spelling of a Dev room is left behind');
    const normalized = normalizeNotificationSettings(def.notificationSettings);
    assert.strictEqual(normalized.onApproval.talkRoom, undefined);
    assert.strictEqual(normalized.onError.talkRoom, undefined);
});

test('pipeline: a connection slot suggests the Dev step\'s literal host, merged across holes on one slot', () => {
    const def = {
        steps: [
            { id: 'h1', type: 'http_request', url: 'https://api.example.com/v1/orders', auth: { connectionId: 'conn_dev' } },
            { id: 'h2', type: 'http_request', url: 'https://files.example.com:8443/up', auth: { connectionId: 'conn_dev' } },
            { id: 'h3', type: 'http_request', url: '{{vars.api_base}}/x', auth: { connectionId: 'conn_dev' } },
            { id: 'h4', type: 'http_request', url: '{{vars.api_base}}/y', auth: { connectionId: 'conn_other' } },
        ],
    };
    const opts = pipe('aut_1', { connSlots: new Map([['conn_dev', 'cn_1'], ['conn_other', 'cn_2']]) });
    scrub.liftAutomationHoles(def, opts);
    const cn1 = opts.slots.filter(x => x.slot === 'connection:cn_1');
    assert.strictEqual(cn1.length, 3);
    for (const x of cn1) assert.deepStrictEqual(x.suggested, { connectionId: 'conn_dev', allowedHosts: ['api.example.com', 'files.example.com'] });
    assert.deepStrictEqual(opts.slots.find(x => x.slot === 'connection:cn_2').suggested, { connectionId: 'conn_other' }, 'a templated url suggests no host');

    const gal = gallery('aut_1');
    scrub.liftAutomationHoles({ steps: [{ id: 'h', type: 'http_request', url: 'https://api.example.com', auth: { connectionId: 'conn_dev' } }] }, gal);
    assert.strictEqual(gal.slots[0].suggested, null, 'a gallery file carries no host either');
});

test('a page agent grant: in-bundle travels as $ref, outside is reported (gallery) or blocking (pipeline)', () => {
    const inBundle = captureBridgeGrants({ agent: { agentId: { $ref: 'agt_1' } } }, [], gallery('web_1'));
    assert.deepStrictEqual(inBundle.payload.agent, { agentId: { $ref: 'agt_1' } });
    assert.ok(!inBundle.report.some(r => r.rule === RULES.UNLISTED_FIELD), 'agent is a listed key');

    const gal = captureBridgeGrants({ agent: { agentId: 'agt_dev' } }, [], gallery('web_1'));
    assert.strictEqual(gal.payload.agent, undefined);
    assert.ok(gal.report.some(r => r.rule === RULES.WEBPAGE_RESOURCE_REFERENCE && r.field === 'bridgeGrants.agent'));
    assert.ok(!JSON.stringify(gal.payload).includes('agt_dev'));

    const opts = pipe('web_1');
    const pip = scrub.captureBridgeGrants({ agent: { agentId: 'agt_dev' } }, [], opts);
    assert.strictEqual(pip.payload.agent, undefined);
    assert.deepStrictEqual(opts.findings.map(f => [f.code, f.severity, f.ref]), [['webpage.agent_not_in_solution', 'blocking', 'web_1']]);
});

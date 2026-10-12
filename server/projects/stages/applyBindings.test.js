/**
 * Bindings into the holes of a release (design 4.1) and the binding validator.
 * Doubles through `deps`; no module mocking.
 *
 * Run: cd server && node --test projects/stages/applyBindings.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { applyBindingsTo, applySeatBinding, validateBinding, normalizeHosts, slotKind, bindingMap } = require('./applyBindings');
const { liftAutomationHoles, liftAppHoles } = require('../packaging/scrub');

/** A Dev automation, lifted by the real pipeline capture so the slot names are the ones capture emits. */
function liftedAutomation() {
    const definition = {
        trigger: { type: 'manual' },
        steps: [
            { id: 'call', type: 'http_request', url: 'https://API.example.com/v1', auth: { type: 'connection', connectionId: 'conn-dev' } },
            { id: 'call2', type: 'http_request', url: 'https://api.example.com/v2', auth: { type: 'connection', connectionId: 'conn-dev' } },
            { id: 'ok', type: 'approval', approval: { assignee: { userId: 'dev-boss' }, escalateTo: { groupId: 'g-dev' }, rule: 'all', prompt: 'OK?' } },
            { id: 'rows', type: 'datatable', op: 'list_rows', datatableKey: 'customers', datatableId: 'tbl_devcustomer1' },
            { id: 'own', type: 'datatable', op: 'list_rows', datatableKey: 'prices', datatableId: 'tbl_stageprice01' },
            { id: 'ask', type: 'ai_step', knowledgeBaseIds: [{ $ref: 'kb_1' }, 'kb-dev-other'] },
            { id: 'fill', type: 'fill_document', documentId: 'doc-dev', documentVersionId: 'v-dev' },
        ],
        notificationSettings: {
            onError: { recipients: [{ type: 'owner' }, { type: 'user', id: 'dev-ops' }], talkRoom: 'dev-room' },
        },
    };
    const slots = [];
    liftAutomationHoles(definition, { ref: 'aut_1', pipeline: true, connSlots: new Map([['conn-dev', 'cn_1']]), slots, findings: [] });
    // In-bundle pointers, resolved to their stage ids the way plan/prepare do first: no holes.
    definition.steps[4].datatableId = 'tbl_stageprice01';
    definition.steps[5].knowledgeBaseIds = definition.steps[5].knowledgeBaseIds.map(v => (v && v.$ref ? 'kb-in-bundle' : v));
    return { entity: { ref: 'aut_1', kind: 'automation', title: 'R', definition }, slots };
}

test('slot grammar and binding maps', () => {
    assert.strictEqual(slotKind('connection:cn_1'), 'connection');
    assert.strictEqual(slotKind('notify:aut_1'), 'approver_seats');
    assert.strictEqual(slotKind('kb:aut_1:knowledgeBaseIds:s1'), 'knowledge_base');
    assert.strictEqual(slotKind('weird:x'), null);
    assert.deepStrictEqual([...bindingMap([{ slot: 'a', value: 1 }, { slot: 'b', value: null }])], [['a', 1]]);
    assert.deepStrictEqual(normalizeHosts(['API.Example.com:443', 'https://x.org/path', 'api.example.com']), ['api.example.com', 'x.org']);
    assert.strictEqual(normalizeHosts(['not a host']), null);
});

test('connection (with allowedHosts), seats, notify, table, kb and document holes of an automation', () => {
    const { entity, slots } = liftedAutomation();
    const names = slots.map(s => s.slot);
    assert.ok(names.includes('connection:cn_1') && names.includes('seats:aut_1:ok') && names.includes('notify:aut_1'));
    const seats = {
        stages: [{ key: 's1', name: 'Finance', approvers: [{ userId: 'prd-fin' }, { groupId: 'g-prd' }], rule: 'quorum', quorum: 1 }],
        finalApprover: { userId: 'prd-cfo' },
        escalateTo: { groupId: 'g-prd-esc' },
        rule: 'first',
    };
    const { applied } = applyBindingsTo('automations', entity, [
        { slot: 'connection:cn_1', value: { connectionId: 'conn-prd', allowedHosts: ['API.example.com'] } },
        { slot: 'seats:aut_1:ok', value: seats },
        { slot: 'notify:aut_1', value: { onError: { recipients: [{ type: 'group', id: 'g-oncall' }], talkRoom: 'prd-room' } } },
        { slot: 'table:customers', value: { datatableId: 'tbl_prdcustomer1' } },
        { slot: 'table:prices', value: { datatableId: 'tbl_must_not_win' } },
        { slot: 'kb:aut_1:knowledgeBaseIds:ask', value: { kbIds: ['kb-prd'] } },
        { slot: 'doc:aut_1:fill', value: { documentId: 'doc-org', documentVersionId: 'v-org' } },
    ], { slots });
    const [call, call2, ok, rows, own, ask, fill] = entity.definition.steps;
    assert.deepStrictEqual(call.auth, { type: 'connection', connectionId: 'conn-prd', allowedHosts: ['api.example.com'] });
    assert.strictEqual(call2.auth.connectionId, 'conn-prd', 'one connection slot binds every step on it');
    // The WHOLE seat shape: Dev's assignee is gone, the chain and the escalation are the binding's.
    assert.deepStrictEqual(ok.approval, { prompt: 'OK?', ...seats });
    assert.ok(!('assignee' in ok.approval));
    assert.strictEqual(rows.datatableId, 'tbl_prdcustomer1');
    assert.strictEqual(own.datatableId, 'tbl_stageprice01', 'a resolved in-bundle pointer is never re-pointed');
    assert.deepStrictEqual(ask.knowledgeBaseIds, ['kb-in-bundle', 'kb-prd']);
    assert.deepStrictEqual([fill.documentId, fill.documentVersionId], ['doc-org', 'v-org']);
    assert.deepStrictEqual(entity.definition.notificationSettings.onError, {
        recipients: [{ type: 'owner' }, { type: 'group', id: 'g-oncall' }], talkRoom: 'prd-room',
    });
    assert.ok(applied.includes('connection:cn_1') && applied.includes('notify:aut_1'));
});

test('an unbound hole stays a hole', () => {
    const { entity, slots } = liftedAutomation();
    applyBindingsTo('automation', entity, new Map(), { slots });
    assert.strictEqual(entity.definition.steps[0].auth.connectionId, null);
    assert.strictEqual(entity.definition.steps[3].datatableId, '');
    assert.ok(!('assignee' in entity.definition.steps[2].approval));
});

test('app seats and KBs are found by the walkAppObjects address capture emits', () => {
    const definition = {
        actions: {
            approve: { kind: 'sequence', steps: [
                { kind: 'request_approval', approverUserIds: ['dev-a'], rule: 'all' },
                { kind: 'request_approval', assigneeUserId: 'dev-b' },
            ] },
        },
        screens: [{ id: 'home', knowledgeBaseIds: ['kb-dev'] }],
    };
    const slots = [];
    liftAppHoles(definition, { ref: 'app_1', pipeline: true, slots, findings: [] });
    const seatSlots = slots.filter(s => s.kind === 'approver_seats').map(s => s.slot);
    assert.strictEqual(seatSlots.length, 2, 'two id-less actions get two addresses');
    const entity = { ref: 'app_1', definition, dataModel: { tables: [{ key: 'orders', source: { datatableId: null } }] } };
    applyBindingsTo('app', entity, {
        [seatSlots[1]]: { approverGroupIds: ['g-prd'], rule: 'first' },
        'kb:app_1:knowledgeBaseIds:home': { kbIds: ['kb-prd'] },
        'table:app_1:source:orders': { datatableId: 'tbl_prdorders001' },
    });
    const [first, second] = definition.actions.approve.steps;
    assert.deepStrictEqual(first, { kind: 'request_approval' }, 'the unbound action stays seatless');
    assert.deepStrictEqual(second, { kind: 'request_approval', approverGroupIds: ['g-prd'], rule: 'first' });
    assert.deepStrictEqual(definition.screens[0].knowledgeBaseIds, ['kb-prd']);
    assert.strictEqual(entity.dataModel.tables[0].source.datatableId, 'tbl_prdorders001');
});

test('webpage slug, grants, tables, KBs; agent KBs; datatable mirror', () => {
    const page = { ref: 'web_1', bridgeGrants: { tables: [{ datatableId: null, mode: 'read' }], integrations: [] }, knowledgeBaseIds: [] };
    applyBindingsTo('webpage', page, {
        'slug:web_1': { slug: 'Prices-PRD' },
        'grant:web_1:gmail_send': { label: 'Mail us' },
        'table:web_1:bridgeTables:0': { datatableId: 'tbl_prd00000001' },
        'kb:web_1:knowledgeBaseIds:page': { kbIds: ['kb-1'] },
    });
    assert.strictEqual(page.slug, 'prices-prd');
    assert.deepStrictEqual(page.bridgeGrants.integrations, [{ tool: 'gmail_send', label: 'Mail us' }]);
    assert.strictEqual(page.bridgeGrants.tables[0].datatableId, 'tbl_prd00000001');
    assert.deepStrictEqual(page.knowledgeBaseIds, ['kb-1']);
    const agent = { ref: 'agt_1', config: { knowledge_base_ids: ['kb-in'] } };
    applyBindingsTo('agents', agent, { 'kb:agt_1:knowledge_base_ids:agent': { kbIds: ['kb-org'] } });
    assert.deepStrictEqual(agent.config.knowledge_base_ids, ['kb-in', 'kb-org']);
    const table = { ref: 'dt_1' };
    applyBindingsTo('datatable', table, { 'mirror:dt_1': { kind: 'nextcloud_table', tableId: 7 } });
    assert.deepStrictEqual(table.source, { kind: 'nextcloud_table', tableId: 7 });
});

test('applySeatBinding writes the full app seat shape', () => {
    const action = { kind: 'request_approval', assigneeUserId: 'old', approverGroupIds: ['x'], quorumCount: 2, prompt: 'p' };
    applySeatBinding(action, { finalApproverUserId: 'cfo', approverUserIds: ['a', 'b'], quorumCount: 1 }, 'app');
    assert.deepStrictEqual(action, { kind: 'request_approval', prompt: 'p', finalApproverUserId: 'cfo', approverUserIds: ['a', 'b'], quorumCount: 1 });
});

// ── validateBinding ────────────────────────────────────────────────────────

const STAGES = [{ projectId: 'uat-1', stage: 'uat' }, { projectId: 'prd-1', stage: 'prd' }];
const OWNED = { dev: ['tbl_dev00000001', 'kb-dev'], 'uat-1': ['tbl_uat00000001'], 'prd-1': ['tbl_prd00000001', 'kb-prd'] };
const baseDeps = () => ({
    solutionStageStore: { listStages: async () => STAGES },
    db: {
        query: async (sql, params) => {
            if (/FROM projects/.test(sql)) return { rows: params[0].map(id => ({ id, knowledge_base_ids: (OWNED[id === 'sol-1' ? 'dev' : id] || []).filter(x => x.startsWith('kb')) })) };
            if (/FROM datatables/.test(sql)) {
                return { rows: params[0].flatMap(p => (OWNED[p === 'sol-1' ? 'dev' : p] || []).filter(x => x.startsWith('tbl')).map(id => ({ id, project_id: p }))) };
            }
            return { rows: [] };
        },
    },
    authorizeConnectionUse: async ({ connectionId, runningUserId }) => (connectionId === 'conn-ok' && runningUserId === 'alice'
        ? { ok: true, mode: 'own' } : { ok: false, reason: 'forbidden' }),
    groupsOf: async () => [],
    validateAssignee: async (seat) => (seat.userId === 'stranger' ? null : seat),
    validatePanel: async (seats) => seats.filter(s => s.userId !== 'stranger'),
    validateStages: async (stages, orgId, owner) => stages.map(st => {
        const kept = (st.approvers || []).filter(s => s.userId !== 'stranger');
        return kept.length ? { ...st, approvers: kept } : { ...st, approvers: [{ userId: owner }], rule: 'first' };
    }),
});
const ctx = (over = {}) => ({ stageProjectId: 'prd-1', solutionId: 'sol-1', stage: 'prd', runAsUserId: 'alice', organizationId: 'acme', deps: baseDeps(), ...over });
const refusal = (why) => (err) => err.status === 400 && err.code === 'binding_invalid' && err.details.why === why;

test('validateBinding refuses another stage\'s table, and Dev\'s', async () => {
    await assert.rejects(validateBinding('table:customers', { datatableId: 'tbl_uat00000001' }, ctx()), refusal('other_stage'));
    await assert.rejects(validateBinding('table:customers', { datatableId: 'tbl_dev00000001' }, ctx()), refusal('other_stage'));
    const own = await validateBinding('table:customers', { datatableId: 'tbl_prd00000001' }, ctx());
    assert.deepStrictEqual(own, { slot: 'table:customers', kind: 'table', value: { datatableId: 'tbl_prd00000001' } });
    const org = await validateBinding('table:customers', { datatableId: 'tbl_org00000001' }, ctx());
    assert.strictEqual(org.value.datatableId, 'tbl_org00000001');
    await assert.rejects(validateBinding('kb:aut_1:knowledgeBaseIds:s1', { kbIds: ['kb-dev'] }, ctx()), refusal('other_stage'));
    await assert.rejects(validateBinding('kb:aut_1:knowledgeBaseIds:s1', { kbIds: ['kb-prd'] }, ctx({ stageProjectId: 'uat-1', stage: 'uat' })), refusal('other_stage'));
});

test('validateBinding: connections are checked for the run-as user, hosts normalised and required in PRD', async () => {
    const ok = await validateBinding('connection:cn_1', { connectionId: 'conn-ok', allowedHosts: ['API.example.com:8443'] }, ctx());
    assert.deepStrictEqual(ok.value, { connectionId: 'conn-ok', allowedHosts: ['api.example.com'] });
    await assert.rejects(validateBinding('connection:cn_1', { connectionId: 'conn-other', allowedHosts: ['a.com'] }, ctx()), refusal('connection_unusable'));
    await assert.rejects(validateBinding('connection:cn_1', { connectionId: 'conn-ok' }, ctx()), refusal('hosts_required'));
    const uat = await validateBinding('connection:cn_1', { connectionId: 'conn-ok' }, ctx({ stage: 'uat' }));
    assert.deepStrictEqual(uat.value.allowedHosts, []);
    await assert.rejects(validateBinding('connection:cn_1', { connectionId: 'conn-ok', allowedHosts: ['bad host!'] }, ctx()), refusal('invalid_hosts'));
});

test('validateBinding: seats through the approval validators', async () => {
    const shape = { stages: [{ key: 's1', approvers: [{ userId: 'bob' }], rule: 'all' }], escalateTo: { groupId: 'g1' } };
    assert.strictEqual((await validateBinding('seats:aut_1:ok', shape, ctx())).kind, 'approver_seats');
    await assert.rejects(validateBinding('seats:aut_1:ok', { assignee: { userId: 'stranger' } }, ctx()), refusal('seat_invalid'));
    await assert.rejects(validateBinding('seats:aut_1:ok', { approvers: [{ userId: 'bob' }, { userId: 'stranger' }] }, ctx()), refusal('seat_invalid'));
    await assert.rejects(validateBinding('seats:aut_1:ok', { stages: [{ key: 's1', approvers: [{ userId: 'stranger' }] }] }, ctx()), refusal('seat_invalid'));
    await assert.rejects(validateBinding('seats:app_1:x', { approverUserIds: ['stranger'] }, ctx()), refusal('seat_invalid'));
    await assert.rejects(validateBinding('seats:aut_1:ok', { rule: 'all' }, ctx()), refusal('no_seat'));
    assert.ok(await validateBinding('notify:aut_1', { onError: { recipients: [{ type: 'user', id: 'bob' }], talkRoom: 'r' } }, ctx()));
    await assert.rejects(validateBinding('notify:aut_1', { onError: { recipients: [{ type: 'user', id: 'stranger' }] } }, ctx()), refusal('seat_invalid'));
});

test('validateBinding: slugs, grants, unknown slots, clearing', async () => {
    assert.deepStrictEqual((await validateBinding('slug:web_1', { slug: ' Prices ' }, ctx())).value, { slug: 'prices' });
    await assert.rejects(validateBinding('slug:web_1', { slug: 'no/slash' }, ctx()), refusal('invalid_value'));
    assert.deepStrictEqual((await validateBinding('grant:web_1:gmail_send', {}, ctx())).value, {});
    await assert.rejects(validateBinding('teleport:x', {}, ctx()), refusal('unknown_slot'));
    assert.deepStrictEqual(await validateBinding('table:x', null, ctx()), { slot: 'table:x', kind: 'table', value: null });
});

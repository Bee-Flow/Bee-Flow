/**
 * The pointer registry: one list of every place a Solution part names another.
 *
 * The load-bearing promise is the round trip. Every location the registry
 * lists must survive toRefs (a real id becomes `{ $ref }`) and fromRefs (the
 * `$ref` becomes the installed id), because a location that only works one way
 * is a part that arrives pointing at the Solution it was copied from.
 *
 * Pure: no store, no module mocking.
 *
 * Run: cd server && node --test projects/packaging/pointers.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    POINTER_LOCATIONS, HOLDER_KINDS, STEERING_FIELDS,
    visitPointers, toRefs, fromRefs, splitIds,
    visitSteeringFields, variablesInSteeringFields,
} = require('./pointers');

const ID = 'dev_target_1';
const step = (s) => ({ definition: { schemaVersion: 2, steps: [{ id: 's1', ...s }] } });

/** One payload per registry row, holding exactly that one pointer. */
const BUILDERS = {
    'automation:call_block:blockId': () => step({ type: 'call_block', blockId: ID }),
    'automation:datatable:datatableId': () => step({ type: 'datatable', datatableId: ID, datatableKey: 'invoices' }),
    'automation:http_request:cacheInto.datatableId': () => step({ type: 'http_request', url: 'https://x', cacheInto: { datatableId: ID, ttlSeconds: 60 } }),
    'automation:ai_step:knowledgeBaseIds': () => step({ type: 'ai_step', knowledgeBaseIds: [ID] }),
    'automation:ai_step:skillIds': () => step({ type: 'ai_step', skillIds: [ID] }),
    'automation:ai_step:agentId': () => step({ type: 'ai_step', agentId: ID }),
    'automation:knowledge_write:knowledgeBaseId': () => step({ type: 'knowledge_write', knowledgeBaseId: ID }),
    'automation:fill_document:documentId': () => step({ type: 'fill_document', documentId: ID }),
    'automation:generate_document:documentId': () => step({ type: 'generate_document', documentId: ID }),
    'app:run_automation:automationId': () => ({ definition: { actions: { go: { kind: 'run_automation', automationId: ID } } } }),
    'app:any object:knowledgeBaseIds': () => ({ definition: { screens: [{ sections: [{ props: { knowledgeBaseIds: [ID] } }] }] } }),
    'app:dataModel.tables[].source:datatableId': () => ({
        definition: {},
        dataModel: { tables: [{ id: 'tbl_app', key: 'orders', source: { kind: 'datatable', datatableId: ID, mode: 'read' }, fields: [] }] },
    }),
    'webpage:bridgeGrants.automations[]:automationId': () => ({ bridgeGrants: { automations: [{ automationId: ID, label: 'Run' }] } }),
    'webpage:bridgeGrants.tables[]:datatableId': () => ({ bridgeGrants: { tables: [{ datatableId: ID, mode: 'read', columns: ['a'] }] } }),
    'webpage:bridgeGrants.agent:agentId': () => ({ bridgeGrants: { agent: { agentId: ID } } }),
    'webpage:metadata:knowledgeBaseIds': () => ({ knowledgeBaseIds: [ID] }),
    'agent:config:knowledge_base_ids': () => ({ config: { knowledge_base_ids: [ID] } }),
    'agent:config:attachedSkillIds': () => ({ config: { attachedSkillIds: [ID] } }),
    'skill:row:knowledge_base_ids': () => ({ knowledge_base_ids: [ID] }),
    'skill:row:allowed_automation_ids': () => ({ allowed_automation_ids: [ID] }),
    'skill:row:automation_id': () => ({ automation_id: ID }),
};
const keyOf = (row) => `${row.holder}:${row.where}:${row.field}`;

test('every registry row has a fixture, and every fixture is a registry row', () => {
    const rows = POINTER_LOCATIONS.map(keyOf).sort();
    assert.deepStrictEqual(Object.keys(BUILDERS).sort(), rows);
    assert.deepStrictEqual([...HOLDER_KINDS].sort(), ['agent', 'app', 'automation', 'skill', 'webpage']);
});

for (const row of POINTER_LOCATIONS) {
    test(`round trip: ${keyOf(row)}`, () => {
        const payload = BUILDERS[keyOf(row)]();
        const seen = [];
        visitPointers(row.holder, payload, (ptr) => seen.push(ptr));
        assert.strictEqual(seen.length, 1, 'exactly the one pointer the fixture holds');
        assert.strictEqual(seen[0].targetKind, row.targetKind);
        assert.strictEqual(!!seen[0].many, !!row.many);

        const rewritten = toRefs(row.holder, payload, new Map([[ID, 'x_1']]));
        assert.strictEqual(rewritten.length, 1);
        assert.strictEqual(rewritten[0].from, ID);
        assert.ok(!JSON.stringify(payload).includes(ID), 'the Dev id is gone');
        assert.ok(JSON.stringify(payload).includes('{"$ref":"x_1"}'));

        const { resolved, unresolved } = fromRefs(row.holder, payload, new Map([['x_1', 'stage_id_9']]));
        assert.strictEqual(resolved.length, 1);
        assert.deepStrictEqual(unresolved, []);
        assert.ok(!JSON.stringify(payload).includes('$ref'));
        const after = [];
        visitPointers(row.holder, payload, (ptr) => after.push(ptr.get()));
        assert.deepStrictEqual(after, [row.many ? ['stage_id_9'] : 'stage_id_9']);
    });
}

test('an id outside the bundle is left for the scrub, untouched', () => {
    const payload = step({ type: 'datatable', datatableId: 'tbl_elsewhere' });
    assert.deepStrictEqual(toRefs('automation', payload, new Map([[ID, 'dt_1']])), []);
    assert.strictEqual(payload.definition.steps[0].datatableId, 'tbl_elsewhere');
});

test('a list keeps its order and only rewrites the ids it knows', () => {
    const payload = { config: { knowledge_base_ids: ['kb_out', 'kb_in'] } };
    toRefs('agent', payload, new Map([['kb_in', 'kb_1']]));
    assert.deepStrictEqual(payload.config.knowledge_base_ids, ['kb_out', { $ref: 'kb_1' }]);
    assert.deepStrictEqual(splitIds(payload.config.knowledge_base_ids), { kept: [{ $ref: 'kb_1' }], outside: ['kb_out'] });
});

test('an unresolved ref is named, never left dangling', () => {
    const payload = {
        bridgeGrants: { automations: [{ automationId: { $ref: 'aut_9' } }] },
        knowledgeBaseIds: [{ $ref: 'kb_1' }, { $ref: 'kb_9' }],
    };
    const { unresolved } = fromRefs('webpage', payload, new Map([['kb_1', 'kb_real']]));
    assert.deepStrictEqual(unresolved.map(u => u.ref).sort(), ['aut_9', 'kb_9']);
    assert.strictEqual(payload.bridgeGrants.automations[0].automationId, null, 'a scalar becomes null');
    assert.deepStrictEqual(payload.knowledgeBaseIds, ['kb_real'], 'a list loses the entry');
});

test('pointers are found in loops, branches and layers, and say where', () => {
    const payload = {
        definition: {
            steps: [
                { id: 'l', type: 'loop', body: [{ id: 'a', type: 'call_block', blockId: ID }] },
                { id: 'p', type: 'parallel', branches: [[{ id: 'b', type: 'datatable', datatableId: ID }]] },
            ],
            layers: { enrich: { steps: [{ id: 'c', type: 'knowledge_write', knowledgeBaseId: ID }] } },
        },
    };
    const seen = [];
    visitPointers('automation', payload, (ptr) => seen.push(`${ptr.layerKey || '-'}/${ptr.stepId}/${ptr.field}`));
    assert.deepStrictEqual(seen.sort(), ['-/a/blockId', '-/b/datatableId', 'enrich/c/knowledgeBaseId']);
});

test('an unknown holder or a malformed payload visits nothing', () => {
    let n = 0;
    visitPointers('notebook', { definition: {} }, () => { n += 1; });
    visitPointers('automation', null, () => { n += 1; });
    visitPointers('app', { definition: 'nonsense' }, () => { n += 1; });
    assert.strictEqual(n, 0);
});

// ═══ Steering fields (D18) ═══════════════════════════════════════════

test('variablesInSteeringFields finds {{vars.api_base}} in an http_request url', () => {
    const def = { steps: [{ id: 'h', type: 'http_request', url: '{{vars.api_base}}/orders', headers: { 'X-Tenant': '{{ vars.tenant }}' } }] };
    assert.deepStrictEqual([...variablesInSteeringFields(def)].sort(), ['api_base', 'tenant']);
});

test('recipients of mail and integration steps steer; a prompt does not', () => {
    const def = {
        steps: [
            { id: 'm', type: 'integration_action', tool: 'gmail_send', inputs: { to: { kind: 'template', template: '{{vars.ops_mail}}' }, body: { kind: 'template', template: '{{vars.greeting}}' } } },
            { id: 'a', type: 'ai_step', prompt: 'Write to {{vars.not_steering}}' },
            { id: 'w', type: 'code', inputs: { callbackUrl: { kind: 'expr', expr: "vars['hook'] + '/done'" } } },
        ],
        layers: { l: { steps: [{ id: 'n', type: 'notification', recipients: '{{vars.team}}' }] } },
    };
    assert.deepStrictEqual([...variablesInSteeringFields(def)].sort(), ['hook', 'ops_mail', 'team']);
});

test('only a WHOLE vars token counts', () => {
    const def = { steps: [{ id: 'h', type: 'http_request', url: '{{myvars.x}} {{steps.vars.y}} {{vars.ok}}' }] };
    assert.deepStrictEqual([...variablesInSteeringFields(def)], ['ok']);
});

test('visitSteeringFields says which field it found, and STEERING_FIELDS lists the families', () => {
    const def = { steps: [{ id: 'h', type: 'http_request', url: 'https://a', headers: {} }, { id: 'x', type: 'set', webhookUrl: 'u' }] };
    const fields = [];
    visitSteeringFields(def, f => fields.push(`${f.stepId}.${f.field}`));
    assert.deepStrictEqual(fields.sort(), ['h.headers', 'h.url', 'x.webhookUrl']);
    assert.strictEqual(STEERING_FIELDS.length, 4);
});

test('a Talk send steers through its room token; a token on another step does not', () => {
    const def = {
        steps: [
            { id: 't', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: '{{vars.room}}', message: '{{vars.text}}' } },
            { id: 'm', type: 'integration_action', inputs: { to: '{{vars.mail_to}}' } },
            { id: 'h', type: 'http_request', url: '{{vars.api_base}}/x' },
            { id: 'g', type: 'integration_action', tool: 'gmail_search', inputs: { token: '{{vars.page_token}}' } },
            { id: 'c', type: 'integration_action', tool: 'teams_send_chat_message', inputs: { chatId: '{{vars.chat}}' } },
            { id: 'n', type: 'integration_action', tool: 'nextcloud_notifications_send', inputs: { userId: '{{vars.nc_user}}' } },
        ],
    };
    assert.deepStrictEqual([...variablesInSteeringFields(def)].sort(), ['api_base', 'chat', 'mail_to', 'nc_user', 'room']);
});

test('app pointers are addressed by path, so two id-less holders never share an address', () => {
    const payload = {
        definition: {
            actions: {
                go: { kind: 'flow', steps: [{ kind: 'run_automation', automationId: 'a1' }, { kind: 'run_automation', automationId: 'a2' }] },
                named: { id: 'act_n', kind: 'run_automation', automationId: 'a3' },
            },
        },
    };
    const seen = [];
    visitPointers('app', payload, (ptr) => seen.push(ptr.actionId));
    assert.deepStrictEqual(seen, ['actions.go.steps[0]', 'actions.go.steps[1]', 'act_n']);
});

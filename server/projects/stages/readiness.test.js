/**
 * Stage readiness (design 6.3): every finding kind, in the core/findings
 * shape, with injected doubles.
 *
 * Run: cd server && node --test projects/stages/readiness.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { readiness, requiredProviders } = require('./readiness');
const { isFinding } = require('../../core/findings/finding');

const manifest = {
    solution: {
        entities: {
            automations: [{
                ref: 'aut_1', definition: {
                    steps: [
                        { id: 'm', type: 'integration_action', tool: 'gmail_send' },
                        { id: 'n', type: 'integration_action', tool: 'internal_thing' },
                        { id: 'h', type: 'http_request', auth: { connectionId: null } },
                    ],
                },
            }],
        },
        slots: [
            { slot: 'connection:cn_1', kind: 'connection', ref: 'aut_1', label: 'API connection' },
            { slot: 'connection:cn_1', kind: 'connection', ref: 'aut_2' },
            { slot: 'seats:aut_1:ok', kind: 'approver_seats', ref: 'aut_1' },
            { slot: 'slug:web_1', kind: 'webpage_slug', ref: 'web_1' },
        ],
        variables: [
            { name: 'api_base', type: 'url', required: true },
            { name: 'limit', type: 'number', required: true },
            { name: 'note', type: 'text', required: false },
            { name: 'mode', type: 'choice', choices: ['a', 'b'] },
        ],
    },
};

const stage = (over = {}) => ({
    projectId: 'prd-1', solutionId: 'sol-1', stage: 'prd', organizationId: 'acme', runAsUserId: 'alice',
    requiresApproval: false, approvalPolicy: null, ...over,
});

const deps = (over = {}) => ({
    authorizeConnectionUse: async ({ connectionId, runningUserId }) => (connectionId === 'conn-ok' && runningUserId === 'alice' ? { ok: true } : { ok: false, reason: 'forbidden' }),
    groupsOf: async () => ['g1'],
    providerForTool: (tool) => (tool === 'gmail_send' ? 'google' : null),
    providerAvailable: async () => false,
    slugOwner: async (slug) => (slug === 'taken' ? 'web-other' : (slug === 'mine' ? 'web-prd-1' : null)),
    validateStages: async (stages) => stages,
    groupMemberIds: async () => ({ ids: ['alice'] }),
    ...over,
});

const codes = (findings) => findings.map(f => `${f.severity}:${f.code}:${f.slot || f.name || f.provider || ''}`);

test('missing bindings, PRD hosts, variables, connections, integrations and addresses', async () => {
    const findings = await readiness({
        stage: stage(),
        manifest,
        bindings: [
            { slot: 'connection:cn_1', kind: 'connection', value: { connectionId: 'conn-ok', allowedHosts: [] } },
            { slot: 'slug:web_1', kind: 'webpage_slug', value: { slug: 'taken' } },
            { slot: 'connection:cn_9', kind: 'connection', value: { connectionId: 'conn-stranger', allowedHosts: ['x.org'] } },
        ],
        values: [{ name: 'api_base', value: '' }, { name: 'limit', value: 'many' }, { name: 'mode', value: 'c' }],
        stamps: new Map([['web_1', { entityId: 'web-prd-1' }]]),
    }, deps());
    assert.ok(findings.every(isFinding), 'the core/findings shape');
    assert.deepStrictEqual(codes(findings), [
        'error:binding.hosts_missing:connection:cn_1',
        'error:binding.missing:seats:aut_1:ok',
        'error:variable.missing:api_base',
        'error:variable.invalid:limit',
        'error:variable.invalid:mode',
        'error:connection.unusable:connection:cn_9',
        'error:integration.missing:google',
        'error:address.taken:slug:web_1',
    ]);
    assert.strictEqual(findings.find(f => f.code === 'connection.unusable').reason, 'forbidden');
});

test('UAT: hosts are optional, a missing integration warns, the own slug is fine', async () => {
    const findings = await readiness({
        stage: stage({ stage: 'uat', projectId: 'uat-1' }),
        manifest,
        bindings: [
            { slot: 'connection:cn_1', kind: 'connection', value: { connectionId: 'conn-ok' } },
            { slot: 'seats:aut_1:ok', kind: 'approver_seats', value: { assignee: { userId: 'bob' } } },
            { slot: 'slug:web_1', kind: 'webpage_slug', value: { slug: 'mine' } },
        ],
        values: [{ name: 'api_base', value: 'https://x' }, { name: 'limit', value: '5' }, { name: 'mode', value: 'a' }],
        stamps: new Map([['web_1', { entityId: 'web-prd-1' }]]),
    }, deps());
    assert.deepStrictEqual(codes(findings), ['warning:integration.missing:google']);
    const available = await readiness({ stage: stage({ stage: 'uat' }), manifest: { solution: { entities: manifest.solution.entities } } },
        deps({ providerAvailable: async (p, who) => p === 'google' && who.runAsUserId === 'alice' }));
    assert.deepStrictEqual(available, []);
});

test('approval_policy.stale: a PRD gate whose chain no longer seats anyone but the owner', async () => {
    const policy = { stages: [{ key: 's1', approvers: [{ groupId: 'g-solo' }] }] };
    const stale = await readiness({ stage: stage({ requiresApproval: true, approvalPolicy: policy }), manifest: { solution: {} } }, deps());
    assert.deepStrictEqual(codes(stale), ['error:approval_policy.stale:']);
    const fresh = await readiness({ stage: stage({ requiresApproval: true, approvalPolicy: policy }), manifest: { solution: {} } },
        deps({ groupMemberIds: async () => ({ ids: ['alice', 'bob'] }) }));
    assert.deepStrictEqual(fresh, []);
    const gateOff = await readiness({ stage: stage({ requiresApproval: false, approvalPolicy: policy }), manifest: { solution: {} } }, deps());
    assert.deepStrictEqual(gateOff, []);
});

test('requiredProviders reads integration steps only', () => {
    const map = requiredProviders(manifest, (tool) => (tool === 'gmail_send' ? 'google' : null));
    assert.deepStrictEqual([...map], [['google', 'aut_1']]);
});

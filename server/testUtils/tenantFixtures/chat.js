// @typecheck strict
/**
 * Tenant-isolation fixtures: what a person of org B keeps around their chats
 * (a direct conversation, a remembered fact, a conversation label) and an
 * agent category of org B. What a fixture is and how the matrix drives it is in
 * testUtils/tenantFixtures.js, which puts these in its list.
 */

'use strict';

const { makeOwnerOrgAdmin } = require('./organisation');

const agentStore = () => require('../../stores/agentStore');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A direct chat of user B (routes/ai/directChat/conversationRoutes.js): every read and write matches the
        // conversation on the caller's user id, so a member of org A gets the conversation's 404.
        kind: 'directConversation',
        mount: '/ai',
        router: () => require('../../routes/ai/directChat/conversationRoutes'),
        create: async ({ userId }) => {
            const conv = await agentStore().createDirectConversation(userId, 'fast');
            return conv.id;
        },
        params: { skillId: 'sk-matrix' },
        routes: [
            'GET /ai/direct/conversations/:id', 'GET /ai/direct/conversations/:id/session-skills',
            'GET /ai/direct/conversations/:id/workspace', 'PATCH /ai/direct/conversations/:id',
            'PUT /ai/direct/conversations/:id/workspace', 'POST /ai/direct/conversations/:id/session-skills/regenerate',
            'POST /ai/direct/conversations/:id/session-skills/:skillId/import',
            'DELETE /ai/direct/conversations/:id/session-skills/:skillId', 'DELETE /ai/direct/conversations/:id',
        ],
    },
    {
        // A conversation label of user B: renamed and deleted under the caller's user id only.
        kind: 'chatLabel',
        mount: '/ai',
        router: () => require('../../routes/ai/directChat/conversationRoutes'),
        create: async ({ userId, index }) => (await agentStore().createLabel(userId, `Label ${index}`, '#6366f1')).id,
        routes: ['PATCH /ai/labels/:id', 'DELETE /ai/labels/:id'],
        bodies: { 'PATCH /ai/labels/:id': { name: 'A name that must not land here' } },
    },
    {
        // A fact the assistant remembered for user B (routes/memory.js, mounted at /agents/memory): the owner's.
        kind: 'memory',
        mount: '/agents/memory',
        router: () => require('../../routes/memory'),
        create: async ({ userId, index }) => {
            const id = await require('../../stores/memoryStore').createMemory(userId, null, 'fact', `Matrix fact ${index}`);
            return String(id);
        },
        routes: [
            'GET /agents/memory/:id', 'PUT /agents/memory/:id', 'POST /agents/memory/:id/restore',
            'POST /agents/memory/review/:id/approve', 'POST /agents/memory/review/:id/reject', 'DELETE /agents/memory/:id',
        ],
        bodies: { 'PUT /agents/memory/:id': { content: 'A fact that must not land here' } },
    },
    {
        // An agent category of org B (routes/agents/crud.js): managed in its own organisation, so a member of org A
        // gets the 403 of manage_agents and the admin of A, who holds it in A, the category's 404.
        kind: 'agentCategory',
        mount: '/agents',
        router: () => require('../../routes/agents').router,
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const category = await agentStore().createAgentCategory(orgId, `Category ${index}`, '', '');
            return category.id;
        },
        routes: ['PATCH /agents/categories/:id', 'DELETE /agents/categories/:id'],
        bodies: { 'PATCH /agents/categories/:id': { name: 'A name that must not land here' } },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };

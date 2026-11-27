// @typecheck strict
/**
 * Tenant-isolation fixtures: an agent of org B and its version history.
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

/**
 * An agent of org B, owned by user B: the fixture of the agent and the versions kinds.
 * @param {{ orgId: string, userId: string, index: number }} ctx
 */
async function createAgentFixture({ orgId, userId, index }) {
    const agentStore = require('../../stores/agentStore');
    // The store's JSDoc types the organisation parameter from its `= null` default,
    // so the id (a string at runtime) is handed over through unknown.
    const organizationId = /** @type {null} */ (/** @type {unknown} */ (orgId));
    const agent = await agentStore.createAgent(`Agent ${index}`, 'matrix fixture', 'You are a test.', userId, null, [], true, true, false, {}, organizationId);
    return agent.id;
}

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'agent',
        mount: '/agents',
        router: () => require('../../routes/agents').router,
        create: createAgentFixture,
        routes: [
            'GET /agents/:id', 'PUT /agents/:id', 'DELETE /agents/:id',
            // The other routes under the agent's id: the owner gets past the gate on each (a 200, or the 400 of an
            // empty body) and a member of org A does not. The agent gates (auth/agentAccess.mts) answer a member of
            // org A the 404 of an unknown id (read, edit, manage) or the turn routes' 403 (chat); the routes behind
            // manage_agents answer a plain member their 403 first.
            'GET /agents/:id/conversations', 'POST /agents/:id/conversations', 'DELETE /agents/:id/history', 'PATCH /agents/:id/publish',
            'POST /agents/:id/publish-version', 'GET /agents/:id/tool-lending', 'GET /agents/:id/tools', 'GET /agents/:id/usage',
            'GET /agents/:id/history', 'POST /agents/:id/chat', 'POST /agents/:id/chat/stream', 'PUT /agents/:id/favorite',
            'POST /agents/:id/persona/parse', 'PUT /agents/:id/tools/:componentId/params', 'PUT /agents/:id/transfer',
            'GET /agents/:id/tests', 'GET /agents/:id/tests/runs', 'POST /agents/:id/tests', 'PUT /agents/:id/tests/:testId',
            'DELETE /agents/:id/tests/:testId', 'POST /agents/:id/tests/run', 'POST /agents/:id/tests/suggest',
            // The public embed page exists for a published agent with Web embed on only: a draft is its 404.
            'GET /agents/:id/embed',
            // A conversation under the agent's id: the id names no conversation, so the owner and a member of org A
            // both get the conversation's 404; the row itself is scoped on its owner (routes/agents/conversations.js).
            'GET /agents/:id/conversations/:convId', 'PATCH /agents/:id/conversations/:convId', 'DELETE /agents/:id/conversations/:convId',
            'PATCH /agents/:id/conversations/:convId/thread-titles', 'GET /agents/:id/conversations/:convId/workspace',
            'PUT /agents/:id/conversations/:convId/workspace',
        ],
        bodies: {
            'POST /agents/:id/chat': { message: 'A turn that must not land here.' },
            'POST /agents/:id/chat/stream': { message: 'A turn that must not land here.' },
            'PUT /agents/:id/tools/:componentId/params': { params: {} },
            'PUT /agents/:id/transfer': { newOwnerId: 'u-matrix-a' },
            'PATCH /agents/:id/conversations/:convId/thread-titles': { threadTitles: {} },
            'POST /agents/:id/tests': { question: 'What must not be asked here?' },
        },
    },
    {
        // The version history of an agent of org B (routes/versions.js, mounted at /versions): the agent's edit
        // gate, with `agentId` as the parameter. The owner lists an empty history; a member of org A gets the 404
        // of an unknown agent on every route, the version routes before any version is looked up.
        kind: 'versions',
        mount: '/versions',
        router: () => require('../../routes/versions'),
        create: createAgentFixture,
        routes: [
            'GET /versions/:agentId', 'GET /versions/:agentId/:versionId', 'DELETE /versions/:agentId/:versionId',
            'POST /versions/:agentId/:versionId/restore', 'POST /versions/:agentId/pre-refine',
        ],
    },
];

module.exports = { FIXTURES };

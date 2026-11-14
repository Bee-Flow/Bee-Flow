// @typecheck strict
/**
 * Tenant-isolation fixtures: the collaborative project. What a fixture is and how the matrix drives
 * it is in testUtils/tenantFixtures.js, which puts these in its list.
 */

'use strict';

const { present } = require('./helpers');

/**
 * A Studio Solution of org B, owned by user B, with its UAT stage.
 * @param {{ orgId: string, userId: string, index: number }} ctx
 */
async function createSolution({ orgId, userId, index }) {
    const projectStore = require('../../stores/projectStore');
    const solution = await projectStore.createProject({
        name: `Solution ${index}`, description: 'matrix fixture', customInstructions: '', color: '', icon: '',
        ownerId: userId, organizationId: orgId, knowledgeBaseIds: [], extractMemories: false, kind: 'solution',
    });
    const [stage] = await require('../../stores/solutionStageStore').createStages({ devProject: solution.id, stages: ['uat'], actorId: userId });
    return { id: solution.id, stageProjectId: stage.projectId };
}

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A collaborative project of org B and the routes under its id (routes/projects.js with its
        // sub-routers). The role ladder (auth/projectAccess.js requireProjectRole) answers someone with
        // no role at all 404, before any body, chat, comment, task or sprint is looked at, so a member
        // of org A gets that on every route; the owner gets past it (a 200, the 400 of an empty body,
        // or the 404 of a chat, comment, task or sprint that does not exist). The Solution routes
        // (stages, releases, deployments, variables, package) answer the owner of a collaborative
        // project 404 as well, so the `solution` kind below drives them.
        kind: 'project',
        mount: '/api/projects',
        router: () => require('../../routes/projects'),
        create: async ({ orgId, userId, index }) => {
            const projectStore = require('../../stores/projectStore');
            // Every field the store destructures, so its inferred parameter type is met; the empty ones take its defaults.
            const project = await projectStore.createProject({
                name: `Project ${index}`, description: 'matrix fixture', customInstructions: '', color: '', icon: '',
                ownerId: userId, organizationId: orgId, knowledgeBaseIds: [], extractMemories: false,
            });
            return project.id;
        },
        routes: [
            'GET /api/projects/:id', 'DELETE /api/projects/:id', 'PUT /api/projects/:id', 'GET /api/projects/:id/activity',
            'POST /api/projects/:id/archive', 'GET /api/projects/:id/avatars/:userId', 'GET /api/projects/:id/board',
            'PUT /api/projects/:id/board', 'POST /api/projects/:id/board/tasks', 'PATCH /api/projects/:id/board/tasks/:taskId',
            'GET /api/projects/:id/changes', 'GET /api/projects/:id/changes/log', 'GET /api/projects/:id/chat-agents',
            'GET /api/projects/:id/chats', 'POST /api/projects/:id/chats', 'DELETE /api/projects/:id/chats/:chatId',
            'GET /api/projects/:id/chats/:chatId', 'PATCH /api/projects/:id/chats/:chatId', 'GET /api/projects/:id/chats/:chatId/messages',
            'POST /api/projects/:id/chats/:chatId/messages', 'DELETE /api/projects/:id/chats/:chatId/messages/:messageId',
            'PATCH /api/projects/:id/chats/:chatId/messages/:messageId',
            'POST /api/projects/:id/chats/:chatId/messages/:messageId/feedback',
            'GET /api/projects/:id/chats/:chatId/messages/:messageId/trace', 'POST /api/projects/:id/chats/:chatId/read',
            'GET /api/projects/:id/comments', 'POST /api/projects/:id/comments', 'DELETE /api/projects/:id/comments/:threadId',
            'GET /api/projects/:id/comments/:threadId', 'PATCH /api/projects/:id/comments/:threadId',
            'POST /api/projects/:id/comments/:threadId/reopen', 'POST /api/projects/:id/comments/:threadId/replies',
            'DELETE /api/projects/:id/comments/:threadId/replies/:commentId',
            'PATCH /api/projects/:id/comments/:threadId/replies/:commentId',
            'POST /api/projects/:id/comments/:threadId/replies/:commentId/feedback', 'POST /api/projects/:id/comments/:threadId/resolve',
            'GET /api/projects/:id/completeness', 'GET /api/projects/:id/compliance-hints',
            'POST /api/projects/:id/compliance-hints/:key/dismiss', 'POST /api/projects/:id/compliance-hints/:key/snooze',
            'PUT /api/projects/:id/conversations', 'POST /api/projects/:id/docs', 'POST /api/projects/:id/docs/:docId/awareness',
            'POST /api/projects/:id/docs/:docId/sync', 'POST /api/projects/:id/docs/:docId/updates', 'POST /api/projects/:id/documents',
            'GET /api/projects/:id/files', 'POST /api/projects/:id/files', 'DELETE /api/projects/:id/files/:fileId',
            'GET /api/projects/:id/files/:fileId/content', 'GET /api/projects/:id/graph', 'POST /api/projects/:id/items/:type/:itemId/seen',
            'PUT /api/projects/:id/kind', 'GET /api/projects/:id/meetings/:meetingId/task-suggestions',
            'POST /api/projects/:id/meetings/:meetingId/task-suggestions/improve', 'GET /api/projects/:id/members',
            'PUT /api/projects/:id/members/:memberId', 'PUT /api/projects/:id/members/:userId/color', 'DELETE /api/projects/:id/mute',
            'PUT /api/projects/:id/mute', 'GET /api/projects/:id/my-chats', 'POST /api/projects/:id/notebooks',
            'GET /api/projects/:id/pins', 'PUT /api/projects/:id/pins', 'DELETE /api/projects/:id/pins/:type/:itemId',
            'POST /api/projects/:id/presence', 'GET /api/projects/:id/principals', 'GET /api/projects/:id/resources',
            'PUT /api/projects/:id/resources', 'POST /api/projects/:id/resources/related', 'POST /api/projects/:id/restore',
            'GET /api/projects/:id/search', 'POST /api/projects/:id/seen', 'POST /api/projects/:id/share',
            'DELETE /api/projects/:id/share/:shareId', 'GET /api/projects/:id/sprints', 'POST /api/projects/:id/sprints',
            'DELETE /api/projects/:id/sprints/:sprintId', 'PATCH /api/projects/:id/sprints/:sprintId',
            'POST /api/projects/:id/sprints/:sprintId/complete', 'POST /api/projects/:id/sprints/:sprintId/items',
            'DELETE /api/projects/:id/sprints/:sprintId/items/:taskId', 'POST /api/projects/:id/sprints/:sprintId/start',
            'GET /api/projects/:id/stream', 'GET /api/projects/:id/tasks', 'POST /api/projects/:id/tasks',
            'DELETE /api/projects/:id/tasks/:taskId', 'PATCH /api/projects/:id/tasks/:taskId',
            'POST /api/projects/:id/tasks/:taskId/improve', 'POST /api/projects/:id/tasks/batch',
            'GET /api/projects/:id/tasks/poker/session', 'POST /api/projects/:id/tasks/poker/session/cancel',
            'POST /api/projects/:id/tasks/poker/session/finish', 'POST /api/projects/:id/tasks/poker/session/next',
            'POST /api/projects/:id/tasks/poker/session/reveal', 'POST /api/projects/:id/tasks/poker/session/start',
            'POST /api/projects/:id/tasks/poker/session/vote', 'GET /api/projects/:id/threads', 'POST /api/projects/:id/threads',
            'POST /api/projects/:id/transfer-owner', 'POST /api/projects/:id/typing', 'POST /api/projects/:id/visit',
        ],
    },
    {
        // A Studio Solution of org B with its UAT stage, and the Solution routes under its id (pipeline,
        // releases, deployments, stages, variables, package). The project role ladder answers a member of
        // org A, and the admin of A who is a plain group member of B, the 404 of an unknown project before
        // any stage, release or deployment is looked up; the owner reads the pipeline.
        kind: 'solution',
        mount: '/api/projects',
        router: () => require('../../routes/projects'),
        create: async (ctx) => (await createSolution(ctx)).id,
        params: { stage: 'uat' },
        routes: [
            'GET /api/projects/:id/pipeline', 'GET /api/projects/:id/deployments',
            'GET /api/projects/:id/deployments/:depId', 'GET /api/projects/:id/package/installs',
            'GET /api/projects/:id/package/releases', 'GET /api/projects/:id/package/releases/:releaseId',
            'GET /api/projects/:id/releases', 'GET /api/projects/:id/releases/:releaseId',
            'GET /api/projects/:id/stages/:stage', 'GET /api/projects/:id/stages/:stage/requirements',
            'GET /api/projects/:id/stages/:stage/variables', 'GET /api/projects/:id/variables',
            'PATCH /api/projects/:id/parts/:ref/options', 'PATCH /api/projects/:id/stages/:stage',
            'PATCH /api/projects/:id/stages/:stage/parts/:ref', 'POST /api/projects/:id/deployments/:depId/cancel',
            'POST /api/projects/:id/deployments/:depId/retry', 'POST /api/projects/:id/package/export',
            'POST /api/projects/:id/package/upgrade', 'POST /api/projects/:id/package/upgrade/plan',
            'POST /api/projects/:id/release-and-deploy', 'POST /api/projects/:id/releases', 'POST /api/projects/:id/stages',
            'POST /api/projects/:id/stages/:stage/deployments', 'POST /api/projects/:id/stages/:stage/pause',
            'POST /api/projects/:id/stages/:stage/plan', 'POST /api/projects/:id/stages/:stage/resume',
            'PUT /api/projects/:id/stages/:stage/bindings', 'PUT /api/projects/:id/stages/:stage/variables',
            'PUT /api/projects/:id/variables',
            'DELETE /api/projects/:id/members/:memberId', 'DELETE /api/projects/:id/threads/:convId',
            'DELETE /api/projects/:id/stages/:stage',
        ],
        orgAdminCaller: true,
    },
    {
        // The UAT stage of a Solution of org B, by its stage project's id (routes/solutionStages.js,
        // projects/stages/stageAuth.js): a member of org A, and the admin of A, get the stage's 404.
        kind: 'solutionStage',
        mount: '/api/solution-stages',
        router: () => require('../../routes/solutionStages').makeSolutionStagesDrainRouter(),
        create: async (ctx) => (await createSolution(ctx)).stageProjectId,
        routes: [
            'GET /api/solution-stages/:stageProjectId', 'GET /api/solution-stages/:stageProjectId/variables',
            'PATCH /api/solution-stages/:stageProjectId/parts/:ref', 'POST /api/solution-stages/:stageProjectId/pause',
            'POST /api/solution-stages/:stageProjectId/resume', 'PUT /api/solution-stages/:stageProjectId/variables',
            'POST /api/solution-stages/:stageProjectId/detach',
        ],
        orgAdminCaller: true,
    },
    {
        // A Blueprint in org B's gallery (routes/projects/packaging.js): read in the caller's own organisation,
        // deleted by its creator only, so a member of org A gets the 404 of an unknown Blueprint.
        kind: 'blueprint',
        mount: '/api/projects',
        router: () => require('../../routes/projects'),
        create: async ({ orgId, userId, index }) => {
            const blueprint = await require('../../stores/blueprintStore').saveBlueprint({
                organizationId: orgId, createdBy: userId, manifest: { solution: { key: `sol_matrix_${index}`, name: `Blueprint ${index}` } },
            });
            return present(blueprint, 'saveBlueprint').id;
        },
        routes: ['GET /api/projects/package/blueprints/:blueprintId', 'DELETE /api/projects/package/blueprints/:blueprintId'],
    },
];

module.exports = { FIXTURES };

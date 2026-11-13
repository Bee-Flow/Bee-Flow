// @typecheck strict
/**
 * Tenant-isolation fixtures: the collaborative project. What a fixture is and how the matrix drives
 * it is in testUtils/tenantFixtures.js, which puts these in its list.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A collaborative project of org B and the routes under its id (routes/projects.js with its
        // sub-routers). The role ladder (auth/projectAccess.js requireProjectRole) answers someone with
        // no role at all 404, before any body, chat, comment, task or sprint is looked at, so a member
        // of org A gets that on every route; the owner gets past it (a 200, the 400 of an empty body,
        // or the 404 of a chat, comment, task or sprint that does not exist). The Solution routes
        // (stages, releases, deployments, variables, package) answer the owner of a collaborative
        // project 404 as well, so this kind cannot tell their gate apart; they stay exempt.
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
];

module.exports = { FIXTURES };

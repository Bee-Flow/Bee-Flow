// @typecheck strict
/**
 * Tenant-isolation fixtures: what a person of org B makes for their own work
 * (a skill, a reusable Step, a Cowork schedule, a reminder, a notification,
 * an icon pack). What a fixture is and how the
 * matrix drives it is in testUtils/tenantFixtures.js, which puts these in its
 * list. Each is the owner's, or shared inside org B only, so a member of org A
 * gets its 404 (or the 403 of a route that names what they may not do).
 */

'use strict';

const { present } = require('./helpers');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A skill of user B in org B (routes/skills): read and changed by its owner, or by org B when shared.
        kind: 'skill',
        mount: '/api/skills',
        router: () => require('../../routes/skills'),
        create: async ({ orgId, userId, index }) => {
            const skill = await require('../../stores/skillStore').createSkill({
                orgId, userId, name: `Skill ${index}`, description: 'matrix fixture', instructions: 'Answer briefly.',
                workflow: '', rules: '', examples: '', icon: '', isShared: false, dynamicActivation: false,
            });
            return present(skill, 'createSkill').id;
        },
        routes: [
            'GET /api/skills/:id', 'GET /api/skills/:id/test-runs', 'GET /api/skills/:id/usage', 'PUT /api/skills/:id',
            'POST /api/skills/:id/ai/improve', 'POST /api/skills/:id/examples/from-message', 'POST /api/skills/:id/test',
            'DELETE /api/skills/:id',
        ],
        bodies: {
            'POST /api/skills/:id/examples/from-message': { conversationId: 'c-matrix', messageIndex: 0 },
            'POST /api/skills/:id/test': { question: 'What must not be asked here?' },
        },
        orgAdminCaller: true,
    },
    {
        // A reusable Step (an automation of kind block) of user B in org B (routes/step.js).
        kind: 'step',
        mount: '/api/step',
        router: () => require('../../routes/step'),
        create: async ({ orgId, userId, index }) => {
            const step = await require('../../stores/automationStore').createStep({
                userId, organizationId: orgId, title: `Step ${index}`, description: '',
                definition: {
                    schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
                    steps: [{ id: 'out', type: 'layer_output', fields: {} }], edges: [],
                },
            });
            return present(step, 'createStep').id;
        },
        routes: [
            'GET /api/step/:id', 'GET /api/step/:id/versions', 'PUT /api/step/:id', 'POST /api/step/:id/publish',
            'POST /api/step/:id/test', 'PUT /api/step/:id/expose', 'PUT /api/step/:id/sharing', 'DELETE /api/step/:id',
        ],
        bodies: {
            'PUT /api/step/:id': { title: 'A title that must not land here' },
            'PUT /api/step/:id/expose': { exposeAsTool: true },
            'PUT /api/step/:id/sharing': { isPublished: true, sharedGroups: [] },
        },
        orgAdminCaller: true,
    },
    {
        // A Cowork schedule of user B (routes/cowork.js): the owner's alone.
        kind: 'coworkSchedule',
        mount: '/api/cowork',
        router: () => require('../../routes/cowork'),
        create: async ({ userId, index }) => {
            const schedule = await require('../../stores/coworkStore').createSchedule({
                userId, title: `Schedule ${index}`, prompt: 'Summarise the week.', repeatInterval: 'daily',
                nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
            });
            return present(schedule, 'createSchedule').id;
        },
        routes: [
            'GET /api/cowork/:id', 'GET /api/cowork/:id/runs', 'GET /api/cowork/:id/stats', 'PUT /api/cowork/:id',
            'POST /api/cowork/:id/run-now', 'POST /api/cowork/:id/toggle', 'DELETE /api/cowork/:id',
        ],
    },
    {
        // A reminder of user B (routes/reminders.js): the owner's alone.
        kind: 'reminder',
        mount: '/api/reminders',
        router: () => require('../../routes/reminders'),
        create: async ({ userId, index }) => {
            const reminder = await require('../../stores/reminderStore').createReminder({
                userId, title: `Reminder ${index}`, message: '', remindAt: new Date(Date.now() + 86_400_000).toISOString(), repeatInterval: null,
            });
            return present(reminder, 'createReminder').id;
        },
        routes: ['PUT /api/reminders/:id', 'POST /api/reminders/:id/complete', 'DELETE /api/reminders/:id'],
        bodies: { 'PUT /api/reminders/:id': { title: 'A title that must not land here' } },
    },
    {
        // A notification of user B (routes/notifications.js): the owner's alone.
        kind: 'notification',
        mount: '/api/notifications',
        router: () => require('../../routes/notifications'),
        create: async ({ userId, index }) => {
            const n = await require('../../stores/notificationStore').createNotification({ userId, taskId: undefined, title: `Notification ${index}` });
            return present(n, 'createNotification').id;
        },
        routes: ['POST /api/notifications/:id/read', 'DELETE /api/notifications/:id'],
    },
    {
        // An icon pack of user B (routes/icons.js): the owner's alone.
        kind: 'iconPack',
        mount: '/api/icons',
        router: () => require('../../routes/icons'),
        create: async ({ userId, index }) => {
            const pack = await require('../../stores/iconStore').createIconPack(userId, `Icons ${index}`, {});
            return present(pack, 'createIconPack').id;
        },
        routes: [
            'GET /api/icons/:id/export', 'PUT /api/icons/:id', 'PATCH /api/icons/:id/icons/:key', 'POST /api/icons/:id/activate',
            'POST /api/icons/:id/bulk-generate', 'DELETE /api/icons/:id',
        ],
        params: { key: 'home' },
    },
    {
        // An MCP access token of user B (routes/mcpTokens.js): switched and revoked under the caller's user id only.
        kind: 'mcpToken',
        mount: '/api/mcp-tokens',
        router: () => require('../../routes/mcpTokens'),
        create: async ({ orgId, userId, index }) => {
            const { record } = await require('../../auth/mcpAccess/tokenStore').createToken({
                userId, orgId, name: `Token ${index}`, scopes: { automations: { level: 'read' } }, ipAllowlist: null, expiresAt: null,
            });
            return /** @type {{ id: string }} */ (record).id;
        },
        routes: ['PATCH /api/mcp-tokens/:id', 'DELETE /api/mcp-tokens/:id'],
        bodies: { 'PATCH /api/mcp-tokens/:id': { enabled: false } },
    },
    {
        // A meeting-summary template of org B (routes/summaryTemplates.js): changed by an admin of org B only.
        kind: 'summaryTemplate',
        mount: '/api/summary-templates',
        router: () => require('../../routes/summaryTemplates'),
        create: async ({ orgId, userId, index }) => {
            await require('./organisation').makeOwnerOrgAdmin(userId);
            const tpl = await require('../../stores/summaryTemplateStore').create({
                scope: 'org', name: `Summary ${index}`, prompt: 'Summarise the meeting.', organizationId: orgId, createdBy: userId,
            });
            return present(tpl, 'create summary template').id;
        },
        routes: ['PATCH /api/summary-templates/:id', 'DELETE /api/summary-templates/:id'],
        bodies: { 'PATCH /api/summary-templates/:id': { name: 'A name that must not land here' } },
        orgAdminCaller: true,
    },
    {
        // A playbook of user B in org B (routes/playbooks): a member of org A gets the 403 of manage_apps on the
        // writes and the playbook's 404 on the read; the admin of A, who holds manage_apps in A, the 404.
        kind: 'playbook',
        mount: '/api/playbooks',
        router: () => require('../../routes/playbooks'),
        create: async ({ orgId, userId, index }) => {
            const pb = await require('../../stores/playbookStore').createPlaybook({
                userId, organizationId: orgId, recipeId: 'invoice_tracker', title: `Playbook ${index}`,
                options: { tableMode: 'new' }, phases: [{ key: 'table', status: 'ready' }], currentPhase: 'table',
            });
            return present(pb, 'createPlaybook').id;
        },
        params: { key: 'table' },
        routes: [
            'GET /api/playbooks/:id', 'PATCH /api/playbooks/:id', 'POST /api/playbooks/:id/phases/:key/access-plan',
            'POST /api/playbooks/:id/phases/:key/register', 'POST /api/playbooks/:id/phases/:key/resolve-plan',
            'POST /api/playbooks/:id/phases/:key/retention-preview', 'POST /api/playbooks/:id/phases/:key/retry',
            'POST /api/playbooks/:id/phases/:key/run', 'POST /api/playbooks/:id/phases/:key/skip', 'DELETE /api/playbooks/:id',
        ],
        orgAdminCaller: true,
    },
    {
        // A named integration connection of user B in org B (routes/integrations/connections.js): its owner, or a
        // platform admin of its organisation, changes it, so a member of org A gets the 403 of someone else's.
        kind: 'integrationConnection',
        mount: '/api/integrations/connections',
        router: () => require('../../routes/integrations/connections'),
        create: async ({ orgId, userId, index }) => {
            const conn = await require('../../stores/integrationConnectionStore').createConnection({
                ownerUserId: userId, orgId, provider: 'matrix_http', label: `Connection ${index}`,
            });
            return present(conn, 'createConnection').id;
        },
        routes: ['PATCH /api/integrations/connections/:id', 'POST /api/integrations/connections/:id/grants', 'DELETE /api/integrations/connections/:id'],
        bodies: {
            'PATCH /api/integrations/connections/:id': { label: 'A label that must not land here' },
            'POST /api/integrations/connections/:id/grants': { granteeType: 'user', granteeId: 'u-matrix-a' },
        },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };

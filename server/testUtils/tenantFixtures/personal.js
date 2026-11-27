// @typecheck strict
/**
 * Tenant-isolation fixtures: what a person of org B makes for their own work
 * (a skill, a reminder, a notification, an icon pack, an integration
 * connection; what a module adds is beside this file in `personal.<module>.js`).
 * What a fixture is and how the
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
            'POST /api/skills/:id/copy', 'DELETE /api/skills/:id',
        ],
        bodies: {
            'POST /api/skills/:id/examples/from-message': { conversationId: 'c-matrix', messageIndex: 0 },
            'POST /api/skills/:id/test': { question: 'What must not be asked here?' },
        },
        orgAdminCaller: true,
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

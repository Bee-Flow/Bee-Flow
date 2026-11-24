// @typecheck strict
/**
 * Tenant-isolation fixtures: a desk of org B (routes/coworkDeskRoutes.js), made by user B, with a cowork of user B on
 * it. Rows that name the outsider (a role they would hold, an invitation of a cowork) go in by SQL, past the use case,
 * which would refuse them: a member of org A, or an administrator of org A who sits in a group of org B, still reads,
 * changes and removes nothing of the desk (404: it does not exist for them; usecases/coworkDesks.mts, every read of
 * stores/coworkDesks.mts counts a person only as an active member of the desk's organisation). What a fixture is and
 * how the matrix drives it is in testUtils/tenantFixtures.js, which puts this in its list.
 */

'use strict';

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'coworkDesk',
        mount: '/api/cowork',
        router: () => require('../../routes/cowork'),
        create: async ({ orgId, userId, index, outsiderId }) => {
            const { coworkDesks } = require('../../stores/coworkDesks.mts');
            const desk = await coworkDesks().createDesk({ organizationId: orgId, ownerId: userId, name: `Desk ${index}` });
            const item = /** @type {{ id: string }} */ (await require('../../stores/coworkStore').createSchedule({
                userId, title: `Desk item ${index}`, prompt: 'Summarise the week.', repeatInterval: 'daily',
                nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
            }));
            await coworkDesks().addMember({ deskId: desk.id, scheduleId: item.id, addedBy: userId, accepted: true });
            if (outsiderId) await coworkDesks().setRoles(desk.id, [{ role: 'invoices', holderId: outsiderId, standInId: outsiderId }]);
            return desk.id;
        },
        routes: [
            'GET /api/cowork/desks/:id', 'PUT /api/cowork/desks/:id/roles', 'POST /api/cowork/desks/:id/members',
            'POST /api/cowork/desks/:id/members/:scheduleId/accept', 'PUT /api/cowork/desks/:id/members/:scheduleId',
            'DELETE /api/cowork/desks/:id/members/:scheduleId', 'DELETE /api/cowork/desks/:id',
        ],
        bodies: {
            'PUT /api/cowork/desks/:id/roles': { roles: [] },
            'POST /api/cowork/desks/:id/members': { scheduleId: 'a-cowork-of-the-caller' },
            'POST /api/cowork/desks/:id/members/:scheduleId/accept': {},
            'PUT /api/cowork/desks/:id/members/:scheduleId': { deskRole: null },
        },
        params: { scheduleId: 'a-cowork-on-the-desk' },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };

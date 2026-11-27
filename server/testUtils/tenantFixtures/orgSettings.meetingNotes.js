// @typecheck strict
/**
 * Tenant-isolation fixtures: the meeting-notes settings and voiceprints of an organisation (the meetingNotes module).
 * What a fixture is and how the matrix drives it is in testUtils/tenantFixtures.js, which
 * finds this file in testUtils/tenantFixtures/ and puts its kinds in the matrix's order.
 */

'use strict';

const { orgArea } = require('./orgSettings');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    ...orgArea('talkNotesSettings', '/api/talk-notes-settings', () => require('../../routes/talkNotesSettings'), {
        memberReads: ['GET /api/talk-notes-settings/:orgId'], adminRoutes: ['PUT /api/talk-notes-settings/:orgId'],
        bodies: { 'PUT /api/talk-notes-settings/:orgId': {} },
    }),
    ...orgArea('gmeetNotesSettings', '/api/gmeet-notes-settings', () => require('../../routes/gmeetNotesSettings'), {
        memberReads: ['GET /api/gmeet-notes-settings/:orgId'], adminRoutes: ['PUT /api/gmeet-notes-settings/:orgId'],
    }),
    ...orgArea('teamsNotesSettings', '/api/teams-notes-settings', () => require('../../routes/teamsNotesSettings'), {
        memberReads: ['GET /api/teams-notes-settings/:orgId'], adminRoutes: ['PUT /api/teams-notes-settings/:orgId'],
    }),
    ...orgArea('voiceprints', '/api/voiceprints', () => require('../../routes/voiceprints'), {
        memberReads: ['GET /api/voiceprints/org/:orgId/coverage'],
        adminRoutes: ['DELETE /api/voiceprints/org/:orgId/user/:userId'],
        params: { userId: 'u-matrix-b' },
    }),
];

module.exports = { FIXTURES };

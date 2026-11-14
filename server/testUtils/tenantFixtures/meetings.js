// @typecheck strict
/**
 * Tenant-isolation fixtures: a meeting note (transcription) of org B. What a
 * fixture is and how the matrix drives it is in testUtils/tenantFixtures.js,
 * which puts these in its list.
 */

'use strict';

const { present } = require('./helpers');

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // A meeting note of user B in org B and the routes under its id (routes/transcriptions/): the store answers
        // the owner, the people it is shared with and the org's admins, so a member of org A, and the admin of A
        // who is a plain group member of B, get the note's 404. The owner reads it.
        kind: 'transcription',
        mount: '/api/transcriptions',
        router: () => require('../../routes/transcriptions'),
        create: async ({ orgId, userId, index }) => {
            const t = await require('../../stores/transcriptionStore').createTranscription({ userId, organizationId: orgId, title: `Meeting ${index}` });
            return present(t, 'createTranscription').id;
        },
        routes: [
            'GET /api/transcriptions/:id', 'GET /api/transcriptions/:id/audio', 'GET /api/transcriptions/:id/export',
            'GET /api/transcriptions/:id/series-previous', 'GET /api/transcriptions/:id/usage', 'PATCH /api/transcriptions/:id',
            'PATCH /api/transcriptions/:id/publish', 'PATCH /api/transcriptions/:id/speakers',
            'POST /api/transcriptions/:id/regenerate-summary', 'POST /api/transcriptions/:id/reidentify-speakers',
            'POST /api/transcriptions/:id/reprocess', 'DELETE /api/transcriptions/:id/filed-lines', 'DELETE /api/transcriptions/:id',
        ],
        bodies: {
            'PATCH /api/transcriptions/:id': { title: 'A title that must not land here' },
            'PATCH /api/transcriptions/:id/publish': { isPublished: true },
        },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };

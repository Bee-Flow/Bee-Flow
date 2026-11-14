// @typecheck strict
/**
 * Tenant-isolation fixtures: the settings an organisation keeps under its own
 * id (`/api/<area>/:orgId`). What a fixture is and how the matrix drives it is
 * in testUtils/tenantFixtures.js, which puts these in its list.
 *
 * Every kind here is org B itself, and the owner of the fixture is made org
 * B's admin. A member of org A gets the 403 of an organisation they do not
 * belong to on every route. The writes and the admin-only reads are also run
 * as the organisation admin of org A who is a plain member of a group of org
 * B (`orgAdminCaller`): administering A is not administering B. The member
 * reads are not, because a plain member of B may read them.
 */

'use strict';

const { makeOwnerOrgAdmin } = require('./organisation');

/**
 * The kinds of one settings area whose id is org B, served by its router at its index.js mount: the reads a
 * MEMBER of the organisation may make (a plain group member of org B is one, so only a member of org A is
 * refused them), and the writes and admin-only reads, which the organisation admin of org A is refused too.
 * The owner's case runs the first route of each kind, with its body.
 * @param {string} kind
 * @param {string} mount
 * @param {() => import('express').Router} router
 * @param {{ memberReads?: string[], adminRoutes?: string[], bodies?: Record<string, unknown>, params?: Record<string, string>, adminOwnerStatus?: number }} routes
 * @returns {import('../tenantFixtures').TenantFixture[]}
 */
function orgArea(kind, mount, router, { memberReads = [], adminRoutes = [], bodies, params, adminOwnerStatus }) {
    /** @type {(ctx: { orgId: string, userId: string }) => Promise<string>} */
    const create = async ({ orgId, userId }) => {
        await makeOwnerOrgAdmin(userId);
        return orgId;
    };
    const base = { mount, router, create, bodies, params };
    return [
        ...(memberReads.length ? [{ ...base, kind, routes: memberReads }] : []),
        ...(adminRoutes.length ? [{ ...base, kind: `${kind}Admin`, routes: adminRoutes, orgAdminCaller: true, ownerStatus: adminOwnerStatus }] : []),
    ];
}

const SHIELD_TYPE = { id: 'cdt_0123456789', name: 'Matrix', method: 'words' };
const SHIELD_DRAFT = { id: 'cdt_0123456789', method: 'words', words: { values: ['matrix'] } };

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    ...orgArea('orgPrivacyShield', '/api/org-privacy-shield', () => require('../../routes/orgPrivacyShield'), {
        memberReads: ['GET /api/org-privacy-shield/:orgId', 'GET /api/org-privacy-shield/:orgId/effective'],
        adminRoutes: [
            'PUT /api/org-privacy-shield/:orgId', 'POST /api/org-privacy-shield/:orgId/custom-data/assist',
            'POST /api/org-privacy-shield/:orgId/custom-data/assist/preview', 'POST /api/org-privacy-shield/:orgId/custom-data/test',
            'POST /api/org-privacy-shield/:orgId/custom-data/tune',
        ],
        bodies: {
            'PUT /api/org-privacy-shield/:orgId': { enabled: false },
            'POST /api/org-privacy-shield/:orgId/custom-data/assist': { type: SHIELD_TYPE, expectLookalikes: [] },
            'POST /api/org-privacy-shield/:orgId/custom-data/assist/preview': { type: SHIELD_TYPE },
            'POST /api/org-privacy-shield/:orgId/custom-data/test': { type: SHIELD_DRAFT, sentences: [{ id: 's1', text: 'A matrix sentence.' }] },
            'POST /api/org-privacy-shield/:orgId/custom-data/tune': { type: SHIELD_DRAFT },
        },
    }),
    ...orgArea('orgAiContext', '/api/org-ai-context', () => require('../../routes/orgAiContext'), {
        memberReads: ['GET /api/org-ai-context/:orgId'],
        adminRoutes: ['PUT /api/org-ai-context/:orgId'],
        bodies: { 'PUT /api/org-ai-context/:orgId': { compactionEnabled: false } },
    }),
    ...orgArea('orgMemory', '/api/org-memory', () => require('../../routes/orgMemory'), {
        adminRoutes: ['GET /api/org-memory/:orgId', 'PUT /api/org-memory/:orgId', 'POST /api/org-memory/:orgId/clear'],
        bodies: { 'POST /api/org-memory/:orgId/clear': { confirm: 'DELETE' } },
    }),
    ...orgArea('aiParticipation', '/api/ai-participation', () => require('../../routes/aiParticipation'), {
        memberReads: ['GET /api/ai-participation/org/:orgId'],
        adminRoutes: ['PUT /api/ai-participation/org/:orgId'],
        bodies: { 'PUT /api/ai-participation/org/:orgId': { autoAllowed: true, alwaysAllowed: true, commentsAutoAllowed: true } },
    }),
    ...orgArea('orgCollab', '/api/org-collab', () => require('../../routes/orgCollab'), {
        memberReads: ['GET /api/org-collab/:orgId'],
        adminRoutes: ['PUT /api/org-collab/:orgId'],
        bodies: { 'PUT /api/org-collab/:orgId': { collabEnabled: true } },
    }),
    ...orgArea('orgIntegrationCache', '/api/org-integration-cache', () => require('../../routes/orgIntegrationCache'), {
        memberReads: ['GET /api/org-integration-cache/:orgId'],
        adminRoutes: ['PUT /api/org-integration-cache/:orgId', 'DELETE /api/org-integration-cache/:orgId/entries'],
        bodies: { 'PUT /api/org-integration-cache/:orgId': { enabled: false } },
    }),
    ...orgArea('orgAzureConfig', '/api/org-azure-config', () => require('../../routes/orgAzureConfig'), {
        adminRoutes: [
            'GET /api/org-azure-config/:orgId/sync-groups/status', 'GET /api/org-azure-config/:orgId',
            'POST /api/org-azure-config/:orgId/sync-groups', 'PUT /api/org-azure-config/:orgId',
            'PUT /api/org-azure-config/:orgId/sync-groups/settings',
        ],
    }),
    ...orgArea('houseStyles', '/api/house-styles', () => require('../../routes/houseStyles'), {
        memberReads: ['GET /api/house-styles/:orgId', 'GET /api/house-styles/:orgId/default'],
        adminRoutes: [
            'GET /api/house-styles/:orgId/:id', 'GET /api/house-styles/:orgId/:id/source.docx', 'POST /api/house-styles/:orgId',
            'PATCH /api/house-styles/:orgId/:id', 'DELETE /api/house-styles/:orgId/:id',
        ],
        // The admin of B gets past the gate to the 404 of a house style that does not exist.
        adminOwnerStatus: 404,
    }),
    ...orgArea('orgSubscription', '/api/subscriptions', () => require('../../routes/subscriptions'), {
        memberReads: ['GET /api/subscriptions/orgs/:orgId', 'GET /api/subscriptions/orgs/:orgId/usage'],
        adminRoutes: [
            'POST /api/subscriptions/orgs/:orgId/cancel', 'GET /api/subscriptions/orgs/:orgId/effective-access',
            'POST /api/subscriptions/orgs/:orgId/upgrade', 'POST /api/subscriptions/orgs/:orgId/cancel-downgrade',
            'POST /api/subscriptions/orgs/:orgId/preview-change', 'POST /api/subscriptions/orgs/:orgId/reactivate',
            'POST /api/subscriptions/orgs/:orgId/reissue-license', 'POST /api/subscriptions/orgs/:orgId/start-trial',
            'PUT /api/subscriptions/orgs/:orgId', 'DELETE /api/subscriptions/orgs/:orgId',
        ],
        // The admin of B gets past the lifecycle gate to the 404 of a subscription that Stripe does not manage; the
        // other routes are the platform administrator's.
        adminOwnerStatus: 404,
    }),
    ...orgArea('customIntegrations', '/api/organizations/:orgId/custom-integrations', () => require('../../routes/orgIntegrations/builder'), {
        adminRoutes: [
            'GET /api/organizations/:orgId/custom-integrations', 'POST /api/organizations/:orgId/custom-integrations',
            'GET /api/organizations/:orgId/custom-integrations/:id', 'GET /api/organizations/:orgId/custom-integrations/:id/session',
            'POST /api/organizations/:orgId/custom-integrations/:id/activate', 'POST /api/organizations/:orgId/custom-integrations/:id/deactivate',
            'POST /api/organizations/:orgId/custom-integrations/:id/refresh-tools',
            'POST /api/organizations/:orgId/custom-integrations/:id/test-call',
            'POST /api/organizations/:orgId/custom-integrations/:id/validate',
            'PUT /api/organizations/:orgId/custom-integrations/:id/credentials',
            'PUT /api/organizations/:orgId/custom-integrations/:id/definition', 'DELETE /api/organizations/:orgId/custom-integrations/:id',
        ],
    }),
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

// @typecheck strict
/**
 * Tenant-isolation fixtures: the tenant support desk (Studio → Support,
 * routes/supportInbox.js, mounted at /api/support-inbox): an inbox of org B,
 * a ticket in it, and org B's canned replies and tags. What a fixture is and
 * how the matrix drives it is in testUtils/tenantFixtures.js, which puts these
 * in its list.
 *
 * The router answers a caller without `support_inbox` its 403 first; the
 * owner of the fixture is made org B's admin, who holds it. The organisation
 * admin of org A holds it in A and is a plain member of a group of org B, so
 * every kind also runs as that caller (`orgAdminCaller`).
 */

'use strict';

const { makeOwnerOrgAdmin } = require('./organisation');

/**
 * The support stores type their optional ids from a `= null` default, so a
 * string id (what they take at runtime) is handed over through unknown.
 * @param {string} v
 */
const id = (v) => /** @type {null} */ (/** @type {unknown} */ (v));

const supportInboxRouter = () => require('../../routes/supportInbox');

/**
 * A Gmail inbox of org B, never connected.
 * @param {string} orgId
 * @param {string} userId
 * @param {number} index
 */
async function createInbox(orgId, userId, index) {
    await makeOwnerOrgAdmin(userId);
    return require('../../stores/supportInboxStore').createInbox({ organizationId: orgId, createdBy: userId, provider: 'gmail', displayName: `Inbox ${index}` });
}

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'supportInbox',
        mount: '/api/support-inbox',
        router: supportInboxRouter,
        create: async ({ orgId, userId, index }) => String((await createInbox(orgId, userId, index)).id),
        routes: [
            'GET /api/support-inbox/inboxes/:id/settings', 'PATCH /api/support-inbox/inboxes/:id',
            'GET /api/support-inbox/inboxes/:id/access', 'PUT /api/support-inbox/inboxes/:id/access',
            'GET /api/support-inbox/inboxes/:id/audit', 'GET /api/support-inbox/inboxes/:id/available-integrations',
            'GET /api/support-inbox/inboxes/:id/scan', 'POST /api/support-inbox/inboxes/:id/scan',
            'GET /api/support-inbox/inboxes/:id/oauth/start', 'PUT /api/support-inbox/inboxes/:id/kb-automation',
            'POST /api/support-inbox/inboxes/:id/disconnect', 'DELETE /api/support-inbox/inboxes/:id',
        ],
        bodies: {
            'PUT /api/support-inbox/inboxes/:id/access': { sharedGroups: [] },
            'PUT /api/support-inbox/inboxes/:id/kb-automation': { enabled: false },
        },
        orgAdminCaller: true,
    },
    {
        // A ticket in an inbox of org B: the ticket's inbox is loaded and its access gate run (routes/support/inboxScope.js loadThreadInScope).
        kind: 'supportInboxThread',
        mount: '/api/support-inbox',
        router: supportInboxRouter,
        create: async ({ orgId, userId, index }) => {
            const inbox = await createInbox(orgId, userId, index);
            const thread = await require('../../stores/supportStore').createThread({
                organizationId: id(orgId), requesterEmail: `requester-${index}@matrix.test`, source: 'email', subject: `Ticket ${index}`, inboxId: id(inbox.id),
            });
            return String(thread.id);
        },
        routes: [
            'GET /api/support-inbox/threads/:id', 'GET /api/support-inbox/threads/:id/context', 'GET /api/support-inbox/threads/:id/events',
            'PATCH /api/support-inbox/threads/:id', 'POST /api/support-inbox/threads/:id/reply', 'POST /api/support-inbox/threads/:id/draft',
        ],
        bodies: {
            'PATCH /api/support-inbox/threads/:id': { status: 'open' },
            'POST /api/support-inbox/threads/:id/reply': { body: 'A reply that must not land here.', internalNote: true },
        },
        orgAdminCaller: true,
    },
    {
        kind: 'supportInboxCanned',
        mount: '/api/support-inbox',
        router: supportInboxRouter,
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const canned = await require('../../stores/supportStore').createCannedResponse({ organizationId: id(orgId), title: `Canned ${index}`, body: 'Hello', createdBy: id(userId) });
            return String(canned.id);
        },
        routes: ['PUT /api/support-inbox/canned/:id', 'DELETE /api/support-inbox/canned/:id'],
        bodies: { 'PUT /api/support-inbox/canned/:id': { title: 'A title that must not land here' } },
        orgAdminCaller: true,
    },
    {
        kind: 'supportInboxTag',
        mount: '/api/support-inbox',
        router: supportInboxRouter,
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const tag = await require('../../stores/supportStore').createTag({ organizationId: id(orgId), name: `tag-${index}` });
            return String(tag.id);
        },
        routes: ['DELETE /api/support-inbox/tags/:id'],
        orgAdminCaller: true,
    },
    {
        // A ticket user B opened in Bee Flow's own support inbox (routes/support.js, mounted at /api/support):
        // the requester reads and answers their own ticket; a member of org A, with no staff right and no
        // ticket token, gets the 404 of an unknown ticket.
        kind: 'supportTicket',
        mount: '/api/support',
        router: () => require('../../routes/support'),
        create: async ({ orgId, userId, index }) => {
            const thread = await require('../../stores/supportStore').createThread({
                organizationId: id(orgId), requesterUserId: id(userId), requesterEmail: 'b@matrix.test', source: 'in_app', subject: `Question ${index}`,
            });
            return String(thread.id);
        },
        routes: ['GET /api/support/threads/:id', 'POST /api/support/threads/:id/messages'],
        bodies: { 'POST /api/support/threads/:id/messages': { body: 'A reply that must not land here.' } },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };

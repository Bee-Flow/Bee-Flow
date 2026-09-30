/**
 * The people surface's server contract, pinned against the server's own
 * source (read as text, like core/api/serverContract.test.ts): every route
 * this feature calls, the body keys it sends, and the response keys its
 * readers rely on. A red line here means the server changed under the phone:
 * port the change, don't loosen the pin.
 */

import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const users = read('auth/admin/userRoutes.js');
const usersStore = read('stores/user/users.js');
const invitations = read('auth/admin/invitationRoutes.js');
const invitationStore = read('stores/invitationStore.js');
const groups = read('auth/admin/groupRoleRoutes.js');
const groupStore = read('stores/user/groups.js');
const tiers = read('routes/ai/config/modelTiers.js');
const providers = read('routes/ai/providers.js');
const access = read('auth/admin/featureAccessRoutes.js');

function expectAll(source: string, needles: string[]): void {
    const missing = needles.filter((n) => !source.includes(n));
    expect(missing).toEqual([]);
}

describe('members (auth/admin/userRoutes.js)', () => {
    it('serves the routes this feature calls', () => {
        expectAll(users, [
            "router.get('/users', requireAuth",
            "router.put('/users/:id', requireOrgAdminForUser",
            "router.post('/users/:id/mfa/reset', requireOrgAdminForUser",
            "router.delete('/users/:id', requireOrgAdminForUser",
        ]);
    });

    it('still allows every key updateMember sends, and the self-demotion opt-in', () => {
        const allowed = /USER_UPDATE_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(users)?.[1] ?? '';
        for (const key of ['groups', 'orgRole', 'status']) expect(allowed).toContain(`'${key}'`);
        expectAll(users, ["'confirmSelfDemotion'", "code: 'confirm_self_demotion'", 'wasEnabled']);
    });

    it('lists the columns the roster reads', () => {
        for (const col of ['"displayName"', 'email', 'status', '"orgRole"', 'groups', '"createdAt"', 'provider']) {
            expect(usersStore).toContain(col);
        }
        expectAll(usersStore, ['mfaEnabled: !!u.mfa_enabled', 'lastSeenAt: u.last_seen_at']);
    });
});

describe('invitations (auth/admin/invitationRoutes.js)', () => {
    it('serves list, create and revoke with the body and answer the phone uses', () => {
        expectAll(invitations, [
            "router.post('/invitations', requireAuth, invitationInviterLimiter",
            "router.get('/invitations', requireAuth",
            "router.delete('/invitations/:id', requireAuth",
            'email: worded(EMAIL_TEXT)',
            "role: worded('An invitation role must be text.')",
            'emailSent: emailResult.success',
            'inviteUrl, // fallback',
            "code: 'seat_cap_exceeded'",
            'inviterName:',
        ]);
        expect(invitationStore).toContain('SELECT id, email, role, status, invited_by, created_at, expires_at');
    });
});

describe('groups and roles (auth/admin/groupRoleRoutes.js)', () => {
    it('serves the group and org-role routes', () => {
        expectAll(groups, [
            "router.get('/groups', requireAuth",
            "router.post('/groups', requireAuth, validate({ body: CreateGroupBody })",
            "router.put('/groups/:id', requireAuth, validate({ body: UpdateGroupBody })",
            "router.delete('/groups/:id', requireAuth",
            "router.post('/groups/:id/members', requireAuth, validate({ body: GroupMemberBody })",
            "router.delete('/groups/:id/members/:userId', requireAuth",
            "router.get('/org-roles', requireAdmin",
            "router.put('/org-roles/:roleId', requirePrimaryOrgAdmin(), validate({ body: OrgRolePermissionsBody })",
        ]);
    });

    it('accepts the keys the phone sends, and answers what the readers read', () => {
        const create = /const CreateGroupBody = z\.object\(\{([\s\S]*?)\}\)\.strict\(\)/.exec(groups)?.[1] ?? '';
        for (const key of ['name:', 'description:', 'organizationId:']) expect(create).toContain(key);
        const update = /const UpdateGroupBody = z\.object\(\{([\s\S]*?)\}\)\.strict\(\)/.exec(groups)?.[1] ?? '';
        for (const key of ['description:', 'allowedTiers:', 'orgRole:']) expect(update).toContain(key);
        expectAll(groups, [
            'userId: worded(MEMBER_TEXT)',
            'permissions: z.array(worded(PERMISSIONS_TEXT)',
            'roles: Object.entries(mapping).map(([id, permissions]) => ({ id, permissions }))',
            'editablePermissions: orgRolePolicy.EDITABLE_PERMISSIONS',
            'res.json({ id: roleId, permissions: stored })',
        ]);
        expectAll(groupStore, ['allowedTiers: parseJSON(g.allowedTiers, [])', 'orgRole', 'source']);
    });
});

describe('model tiers (routes/ai/config/modelTiers.js, routes/ai/providers.js)', () => {
    it('serves the tier routes with the shapes the readers read', () => {
        expectAll(tiers, [
            "router.get('/config/custom-tiers-list', requireAuth",
            "router.get('/config/org-custom-chat-models', requireAuth",
            "router.post('/config/org-custom-chat-models', requireAuth",
            'const { tiers } = req.body;',
            'res.json({ success: true, orgId, warnings, tiers: finalTiers })',
            'res.json({ tiers: list })',
            'orgTiers,',
            'globalTiers: globalTiers.map',
        ]);
        for (const key of ['label:', 'icon:', 'description:', 'modelId:', 'euModelId:', 'maxTokens:', 'temperature:', 'allowedTaskTypes']) {
            expect(tiers).toContain(key);
        }
        expect(tiers).toContain("t.id.startsWith('custom:')");
    });

    it('lists providers and their models', () => {
        expectAll(providers, [
            "router.get('/providers', requireAuth",
            "router.get('/providers/:id/models', requireAuth",
            'providers: maskedProviders',
            'res.json({ models, providerId: provider.id, providerName: provider.name })',
        ]);
    });
});

describe('access (auth/admin/featureAccessRoutes.js)', () => {
    it('serves the matrix read and both grant writes', () => {
        expectAll(access, [
            "router.get('/organizations/:orgId/group-access', requireOrgAdmin('orgId')",
            "router.put('/organizations/:orgId/org-access', requireOrgAdmin('orgId'), validate({ body: GrantedBody })",
            "router.put('/groups/:id/access', requireAuth, validate({ body: GrantedBody })",
            'const GrantedBody = z.object({ granted: idList',
        ]);
    });

    it('answers the fields the reader reads', () => {
        const body = /async function buildGroupAccessResponse[\s\S]*?\n\}/.exec(access)?.[0] ?? '';
        for (const key of ['orgId,', 'mode: snap.mode', 'capabilities,', 'ceiling:', 'everyone:', 'groups,', 'betaGoverned:']) {
            expect(body).toContain(key);
        }
        expect(body).toContain('({ id: c.id, kind: c.kind, name: c.name, description: c.description, category: c.category');
        expect(body).toContain('({ id: g.id, name: g.name, granted:');
    });
});

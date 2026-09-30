/**
 * The access model is a port, so it is pinned to both originals by reading
 * their source (ARCHITECTURE.md, "Sharing logic with the web app"):
 *
 * - the SERVER: the routes and fields the snapshot is read from, the
 *   org-admin roles requireOrgAdmin accepts, the super-admin predicate, the
 *   tier ladder and the two lock reasons the resolver writes;
 * - the WEB: EntitlementsContext's tier table and lock-reason expression,
 *   LicenseContext's delegation to `can`, studioApps' makeCanUse.
 *
 * When one of these goes red the other side changed. Update the port; do not
 * loosen the pin.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ORG_ADMIN_PERMISSION, ORG_ADMIN_ROLES } from './model/roles';
import { LEGACY_TIER_ALIAS, TIER_HIERARCHY } from './model/tiers';

const REPO = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** Whitespace-insensitive containment, so a reformat is not a failure. */
const squash = (text: string) => text.replace(/\s+/g, ' ');
const contains = (source: string, snippet: string) => squash(source).includes(squash(snippet));

describe('the server answers the snapshot is read from', () => {
    it('GET /auth/my-entitlements serves the snapshot plus the registry with licenseFeature', () => {
        const src = read('server/auth/admin/featureAccessRoutes.js');
        expect(src).toContain("router.get('/my-entitlements', requireAuth");
        expect(contains(src, 'licenseFeature: c.licenseFeature || null')).toBe(true);
        expect(read('server/auth/adminRoutes.js')).toContain("require('./admin/featureAccessRoutes')");
        expect(read('server/auth/index.js')).toContain("require('./adminRoutes')");
        expect(read('server/index.js')).toContain("app.use('/auth', authRouter)");
    });

    it('the resolver still writes every field readEntitlements reads, and only two lock reasons', () => {
        const src = read('server/core/entitlements/entitlements.js');
        const snapshot = src.slice(src.indexOf('const snapshot = {'), src.indexOf('_sets: {'));
        for (const key of ['mode', 'tier:', 'superAdmin:', 'degraded:', 'ceiling:', 'effective:', 'reasons:']) {
            expect({ key, found: snapshot.includes(key) }).toEqual({ key, found: true });
        }
        expect(contains(src, "reasons[cap.id] = inCeil ? 'not_granted' : 'ceiling';")).toBe(true);
    });

    it('GET /api/license/status still answers tier, source, features and serverOverride', () => {
        expect(read('server/routes/license.js')).toContain("router.get('/status'");
        expect(read('server/index.js')).toContain("app.use('/api/license', require('./routes/license'))");
        const status = read('server/license/index.js');
        const body = status.slice(status.indexOf('async function getLicenseStatus('));
        for (const key of ['tier,', 'source,', 'features,', 'serverOverride:']) {
            expect({ key, found: body.includes(key) }).toEqual({ key, found: true });
        }
    });

    it('/auth/user and /auth/my-permissions still carry the fields the snapshot takes', () => {
        const me = read('server/auth/login/currentUserRoutes.js');
        for (const key of ['isAdmin:', 'role:', 'organizationId:', 'orgRole:', 'simpleMode:', 'featureFlags:', 'organization:']) {
            expect({ key, found: me.includes(key) }).toEqual({ key, found: true });
        }
        expect(contains(me, 'return { id: org.id, name: org.name || null, logo: org.logo || null };')).toBe(true);
        expect(contains(me, "notebooks: notebooksEnabled !== false && notebooksEnabled !== 'false'")).toBe(true);
        const perms = read('server/auth/login/myPermissionsRoutes.js');
        expect(contains(perms, "betaFeatures, canUseFeature, orgRole: user?.orgRole || ''")).toBe(true);
    });
});

describe('the server role predicates', () => {
    const src = read('server/auth/permissions.js');

    it('ORG_ADMIN_ROLES is ORG_ADMIN_VARIANTS, which requireOrgAdmin checks', () => {
        expect(contains(src, 'const ORG_ADMIN_VARIANTS = Object.freeze([OrgRoles.ORG_ADMIN, OrgRoles.LEGACY_ADMIN]);')).toBe(true);
        expect(contains(src, "ORG_ADMIN: 'org_admin',")).toBe(true);
        expect(contains(src, "LEGACY_ADMIN: 'admin',")).toBe(true);
        expect([...ORG_ADMIN_ROLES].sort()).toEqual(['admin', 'org_admin']);
        const gate = src.slice(src.indexOf('function requireOrgAdmin('), src.indexOf('function isSuperAdmin('));
        expect(gate).toContain('!isOrgAdminRole(user.orgRole)');
    });

    it('the org_admin role carries the org_admin permission, and no other built-in role does', () => {
        const roles = JSON.parse(read('server/config/orgRoles.json')) as Record<string, { permissions?: string[] }>;
        const holders = Object.entries(roles)
            .filter(([, role]) => role.permissions?.includes(ORG_ADMIN_PERMISSION))
            .map(([id]) => id);
        expect(holders).toEqual(['org_admin']);
    });

    it('a super admin is the session flag or the platform role', () => {
        expect(contains(src, "return !!(req.session?.isAdmin || req.session?.user?.role === 'admin');")).toBe(true);
    });
});

describe('the tier ladder', () => {
    it('matches server/license/tiers.js', () => {
        const src = read('server/license/tiers.js');
        expect(contains(src, `const TIER_HIERARCHY = [${TIER_HIERARCHY.map((t) => `'${t}'`).join(', ')}];`)).toBe(true);
        expect(contains(src, "const LEGACY_TIER_ALIAS = { pro: 'enterprise', };")).toBe(true);
        expect(LEGACY_TIER_ALIAS).toEqual({ pro: 'enterprise' });
    });
});

describe('the web logic this ports', () => {
    it('EntitlementsContext: tier table, licence-feature mapping and lock reason', () => {
        const src = read('agent-hub/src/components/licensing/EntitlementsContext.jsx');
        expect(contains(src, 'const TIER_RANK = { community: 0, enterprise: 1, full: 2 };')).toBe(true);
        expect(contains(src, "const LEGACY_TIER_ALIAS = { pro: 'enterprise' };")).toBe(true);
        expect(
            contains(src, 'if (c.licenseFeature && !(c.licenseFeature in featureToCapId)) featureToCapId[c.licenseFeature] = c.id;'),
        ).toBe(true);
        expect(
            contains(
                src,
                "lockReason: (id) => (has(effSets, id) ? null : (has(ceilSets, id) ? 'not_granted' : (state.reasons[resolveId(id)] || 'ceiling'))),",
            ),
        ).toBe(true);
        expect(contains(src, 'integration: new Set([...(state.effective.integration || []), ...(state.effective.mcp || [])]),')).toBe(true);
    });

    it('LicenseContext.hasFeature delegates to the entitlements', () => {
        const src = read('agent-hub/src/components/licensing/LicenseContext.jsx');
        expect(contains(src, 'const hasFeature = useCallback((name) => entCan(name), [entCan]);')).toBe(true);
        expect(contains(src, "export const TIER_HIERARCHY = ['community', 'enterprise', 'full'];")).toBe(true);
    });

    it('studioApps: makeCanUse and the lock hint keys', () => {
        const src = read('agent-hub/src/components/admin/Studio/studioApps.jsx');
        expect(
            contains(
                src,
                "!!(user?.canUseFeature?.[id] ?? (user?.permissions?.includes('all') || user?.betaFeatures?.includes(id)));",
            ),
        ).toBe(true);
        for (const key of ['studio.locked_not_granted', 'studio.locked_training', 'studio.locked_upgrade']) {
            expect(src).toContain(`'${key}'`);
        }
    });
});

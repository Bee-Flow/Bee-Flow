/**
 * The entitlement snapshot of ONE organisation, read for an administrator who
 * looks at it: the org's own plan/licence ceiling, its access menu and its
 * org-wide grants, never the (elevated) tier of whoever asks. A platform admin
 * who picks organisation X sees X's real state.
 *
 * Moved down from auth/admin/featureAccessRoutes.js so both that router (the
 * Access matrix, the organisation access menu) and the integration-availability
 * use case (usecases/integrations/orgIntegrationAvailability.mts) read the same
 * thing without a router being required for it.
 *
 * The collaborators are a parameter, defaulting to the real modules on first
 * use: the router passes the modules it holds, so a test that swaps those still
 * reaches every read made here.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** Capability ids per kind, as the resolver serialises its sets. */
export interface KindLists { core?: string[]; beta?: string[]; integration?: string[]; [kind: string]: string[] | undefined }

/** The part of a resolver snapshot the org-scoped readers use. */
export interface OrgEntitlementSnapshot {
    mode: 'cloud' | 'self-hosted';
    degraded?: boolean;
    /** The plan / licence menu. */
    ceiling: KindLists;
    /** The ceiling narrowed by the org's access menu (what the org may use). */
    orgAvailable: KindLists;
    /** The org-wide "All members" grants. */
    orgEnabled: KindLists;
    [extra: string]: unknown;
}

/** One descriptor of core/entitlements/capabilityRegistry. */
export interface CapabilityLike {
    id: string;
    kind: string;
    name?: string;
    description?: string;
    category?: string;
    lifecycle?: string;
    userFacing?: boolean;
    groupTogglable?: boolean;
    groupScoped?: boolean;
}

export interface EntitlementsLike {
    resolveEntitlements(ctx: { userId: null; orgId: string; session: null; req: null }): Promise<OrgEntitlementSnapshot>;
    registry: {
        refreshMcpIntegrationDescriptors(): Promise<unknown>;
        refreshModuleCapabilityFilter(): Promise<unknown>;
        listCapabilities(): CapabilityLike[];
    };
}

interface UserStoreLike {
    getOrgAvailableCapabilities(orgId: string): Promise<string[] | null | undefined>;
}

export interface SnapshotDeps {
    entitlements?: EntitlementsLike;
    userStore?: UserStoreLike;
}

const realEntitlements = (): EntitlementsLike => nodeRequire('./entitlements.js') as EntitlementsLike;
const realUserStore = (): UserStoreLike => nodeRequire('../../stores/userStore.js') as UserStoreLike;

/**
 * Resolve the ORG-scoped entitlement snapshot (ceiling + actual org-wide grants)
 * independent of who is asking: uses the org's own tier, never the caller's
 * (super-admin) elevated tier, so the matrix shows the real org state.
 */
export async function resolveOrgEntitlementSnapshot(orgId: string, deps: SnapshotDeps = {}): Promise<OrgEntitlementSnapshot> {
    const entitlements = deps.entitlements ?? realEntitlements();
    return entitlements.resolveEntitlements({ userId: null, orgId, session: null, req: null });
}

/** Every id of the three kinds, core first. */
export function unionKindArrays(kindObj: KindLists | null | undefined): string[] {
    const k = kindObj || {};
    return [...(k.core || []), ...(k.beta || []), ...(k.integration || [])];
}

export interface OrgAvailabilityPayload {
    orgId: string;
    mode: OrgEntitlementSnapshot['mode'];
    capabilities: Array<Pick<CapabilityLike, 'id' | 'kind' | 'name' | 'description' | 'category' | 'lifecycle'>>;
    /** The full plan/licence menu to choose from. */
    ceiling: string[];
    /** What the org may currently use. */
    available: string[];
    /** No access menu stored: the org may use its whole ceiling. */
    unrestricted: boolean;
}

/**
 * The read behind GET /auth/organizations/:orgId/org-availability: the
 * matrix-visible capabilities, the org's plan ceiling and its access menu.
 */
export async function buildOrgAvailabilityResponse(orgId: string, deps: SnapshotDeps = {}): Promise<OrgAvailabilityPayload> {
    const entitlements = deps.entitlements ?? realEntitlements();
    const userStore = deps.userStore ?? realUserStore();
    const snap = await resolveOrgEntitlementSnapshot(orgId, { entitlements });
    await entitlements.registry.refreshMcpIntegrationDescriptors(); // MCP servers as integration caps
    await entitlements.registry.refreshModuleCapabilityFilter();    // drop un-imported module caps
    const matrixCaps = entitlements.registry.listCapabilities().filter(c => c.userFacing && c.groupTogglable);
    const capIdSet = new Set(matrixCaps.map(c => c.id));
    const capabilities = matrixCaps.map(c => ({ id: c.id, kind: c.kind, name: c.name, description: c.description, category: c.category, lifecycle: c.lifecycle }));
    const inMatrix = (ids: KindLists) => unionKindArrays(ids).filter(id => capIdSet.has(id));
    const stored = await userStore.getOrgAvailableCapabilities(orgId); // null = unrestricted
    return {
        orgId,
        mode: snap.mode,
        capabilities,
        ceiling: inMatrix(snap.ceiling),
        available: inMatrix(snap.orgAvailable),
        unrestricted: stored == null,
    };
}

export interface ModuleRequirement {
    id: string;
    label: string;
    met: boolean;
    detail?: string;
}

export interface ModuleCapability {
    id: string;
    label: string;
    // null when the capability id no longer resolves in the server registry
    kind: string | null;
}

export interface AdminModule {
    id: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    version: string;
    available: boolean;
    status: 'imported' | 'removed' | 'unavailable';
    source: 'default' | 'explicit';
    importedAt: string | null;
    importedBy: string | null;
    requirementsMet: boolean;
    requirements: ModuleRequirement[];
    capabilities: ModuleCapability[];
}

export interface ModuleMutationResponse {
    ok: true;
    module: AdminModule;
}

export type ModulePricingType = 'free' | 'one_time' | 'subscription';

export type ModuleBillingInterval = 'month' | 'year';

// Server-derived typed pricing (v3.1). Never hand-build this from `prices[]`
// on the client — the server owns the derivation.
export interface MarketplacePricing {
    type: ModulePricingType;
    amount?: number | null;    // minor units (cents)
    currency?: string | null;
    interval?: ModuleBillingInterval | null;
}

export interface MarketplaceEntitlement {
    status: string;            // active | pending | expired | revoked | …
    expiresAt: string | null;  // ISO; null for perpetual (one-time / free)
}

export interface MarketplaceModule {
    id: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    vendor?: string | null;
    latestVersion: string;
    // null (or absent on a v1 hub) reads as free — render defensively.
    pricing?: MarketplacePricing | null;
    channels?: string[];
    installCount?: number | null;
    pendingRestart?: boolean;
    entitled: boolean;
    entitlement?: MarketplaceEntitlement | null;
    installed: boolean;
    installedVersion?: string | null;
    updateAvailable: boolean;
    // Derived server-side; 'expired' means a lapsed subscription whose module
    // capabilities have dropped even though the package may still be on disk.
    status: 'available' | 'entitled' | 'installed' | 'expired';
}

export interface MarketplacePage {
    connected: boolean;
    hubUrl?: string;
    stale?: boolean;
    modules: MarketplaceModule[];
    nextCursor?: string | null;
}

// POST /connect echoes hubClient.connect(): the hub-issued install identity.
export interface ConnectResponse {
    ok: true;
    connection: { install_id: string; tier: string | null; subject: string | null };
}

export interface PurchaseResponse {
    ok: true;
    checkoutUrl?: string;   // present for paid modules → open in a new tab
    purchaseId?: string;
    status?: 'active' | 'pending';
}

export interface RefreshEntitlementsResponse {
    ok: true;
    entitledModuleIds: string[];
}

export interface InstallProgress {
    // 'staged' is terminal: the package is verified + stored but needs a server
    // restart (or explicit activate-staged) before it runs.
    phase: 'downloading' | 'verifying' | 'migrating' | 'activating' | 'staged' | 'done' | 'error';
    pct?: number;
    error?: string;         // e.g. 'consent_required'
    detail?: { missingPermissions?: string[] } | null;
}

export interface UpdateResponse {
    ok: true;
    version?: string;
    requiresRestart?: boolean;
}

export type LedgerVersionStatus =
    'active' | 'retired' | 'staged' | 'failed' | 'incompatible' | 'quarantined';

export interface ModuleHealthRow {
    moduleId: string;
    ledgerStatus: LedgerVersionStatus | null;
    version: string | null;
    running: boolean;
    pendingRestart: boolean;
    source: string | null;   // 'hub' | 'sideload' | …
    entitlement: { state: string; kind: string | null; exp: number | null } | null;
    lastActivationError: string | null;
    crashesInWindow: number;
    disposeTimeouts: number;
    restartAdvised: boolean;
    capabilityConflicts: unknown[];
    healTerminal: string | null;
}

export interface ModulesHealthResponse {
    hub: unknown;
    refresher: unknown;
    runtime: unknown;
    modules: ModuleHealthRow[];
}

export interface ModuleLogEntry {
    ts: number | string;
    seq: number;
    level: string;
    msg: string;
}

export interface ModuleLogsResponse {
    logs: ModuleLogEntry[];
    replica?: string | null;
}

export interface ModuleAuditResponse {
    audit: Array<Record<string, unknown>>;
}

export interface LedgerVersion {
    moduleId: string;
    version: string;
    status: LedgerVersionStatus;
    source: string | null;
    prunedAt: string | null;
    hasPackageFile: boolean;
    installedAt: string | null;
    error?: string | null;
}

export interface SideloadResponse {
    ok: true;
    version: string;
    requiresRestart?: boolean;
}

export interface UpdatePolicy {
    channel: 'stable' | 'beta';
    pin: 'none' | 'major' | 'minor';
}

export interface ModulePermissionEntry {
    id: string;
    reason?: string | null;
}

export interface MarketplaceMediaEntry {
    media_id: string;
    content_type: string;
}

export interface MarketplaceHubVersion {
    version: string;
    channel?: string | null;
    changelog?: string | null;
    yanked?: boolean;
}

// GET /marketplace/:id. A v1 hub omits most of the rich fields — every
// consumer must treat them as optional.
export interface MarketplaceModuleDetail extends MarketplaceModule {
    readme?: string | null;
    media?: MarketplaceMediaEntry[];
    permissions?: Array<string | ModulePermissionEntry>;
    capabilities?: unknown[];
    versions?: MarketplaceHubVersion[];
    ledgerVersions?: LedgerVersion[];
    grantedPermissions?: { list: string[]; acceptedBy?: string | null; acceptedAt?: string | null } | null;
    updatePolicy?: UpdatePolicy | null;
    prices?: unknown[];
    install_count?: number | null;
}

export interface PurchaseVars {
    id: string;
    /** Stripe Checkout return URLs — forwarded to the hub so the customer
     *  lands back on the marketplace tab after paying / cancelling. */
    successUrl?: string;
    cancelUrl?: string;
}

export interface InstallVars {
    id: string;
    version?: string;
    // Permission ids the operator accepted in the consent dialog. A package
    // needing more than granted ∪ accepted fails progress with consent_required.
    acceptedPermissions?: string[];
}

export interface UpdateVars {
    id: string;
    acceptedPermissions?: string[];
}

export interface RollbackVars {
    id: string;
    version?: string;
    force?: boolean;
}

export interface SideloadVars {
    // Raw .bfmod bytes; File and Blob both satisfy BodyInit.
    file: Blob | ArrayBuffer;
    acceptedPermissions?: string[];
}

export interface OfflineGrantVars {
    id: string;
    // Parsed .bfgrant JSON, posted verbatim.
    grant: Record<string, unknown>;
}

export interface UpdatePolicyVars extends UpdatePolicy {
    id: string;
}

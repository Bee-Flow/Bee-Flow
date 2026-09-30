/**
 * Contract readers for the two answers core/access fetches itself. The
 * permissions answer is core/auth's (readPermissions), read once there.
 */

import { field, nullable, shapeOf } from '@/core/api/contract';

import { normalizeTier } from './model/tiers';
import type { CapabilityRow, Entitlements, KindLists, LicenseInfo } from './model/types';

const readBuckets = shapeOf({
    core: field.strArray,
    beta: field.strArray,
    integration: field.strArray,
    mcp: field.strArray,
});

/**
 * The kind buckets. An older server still sends a separate `mcp` bucket; the
 * web folds it into `integration` so deploy order cannot break gating, and so
 * does this.
 */
export function readKindLists(raw: unknown): KindLists {
    const { core, beta, integration, mcp } = readBuckets(raw);
    return { core, beta, integration: [...integration, ...mcp] };
}

/** `{ capabilityId: 'not_granted' | 'ceiling' | … }`, strings only. */
function readReasons(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, reason] of Object.entries(raw)) {
        if (typeof reason === 'string') out[id] = reason;
    }
    return out;
}

const readCapabilityRow: (raw: unknown) => CapabilityRow = shapeOf({
    id: field.str(''),
    kind: field.str(''),
    licenseFeature: field.strOrNull,
});

const readEntitlementFields = shapeOf({
    mode: field.oneOf(['cloud', 'self-hosted'] as const, 'cloud'),
    tier: field.str('community'),
    superAdmin: field.bool(false),
    degraded: field.bool(false),
    ceiling: readKindLists,
    effective: readKindLists,
    reasons: readReasons,
    registry: field.list(readCapabilityRow),
});

/** GET /auth/my-entitlements (server/auth/admin/featureAccessRoutes.js). */
export const readEntitlements: (raw: unknown) => Entitlements | null = nullable((raw) => {
    const read = readEntitlementFields(raw);
    return { ...read, tier: normalizeTier(read.tier) };
});

const readLicenseFields = shapeOf({
    tier: field.str('community'),
    source: field.str('default'),
    features: field.strArray,
    serverOverride: field.bool(false),
});

/** GET /api/license/status (server/license/index.js getLicenseStatus), the gating part. */
export const readLicenseInfo: (raw: unknown) => LicenseInfo | null = nullable((raw) => {
    const read = readLicenseFields(raw);
    return { ...read, tier: normalizeTier(read.tier) };
});

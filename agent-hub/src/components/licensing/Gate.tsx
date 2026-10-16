import React from 'react';
import { useEntitlements } from './EntitlementsContext';

interface GateProps {
    capability?: string;
    tier?: string;
    fallback?: React.ReactNode;
    children?: React.ReactNode;
    loadingFallback?: React.ReactNode;
}

/**
 * Gate — the single display-only capability gate. Replaces the scattered
 * hasFeature/hasTier/RequireTier/LockedIfBelow/FeatureGate checks. The
 * authoritative gate is always server-side (requireCapability); this only
 * controls what the UI shows.
 *
 *   <Gate capability="webpages"><WebpagesButton /></Gate>
 *   <Gate capability="swarm" fallback={<UpgradeHint/>}>...</Gate>
 *   <Gate tier="enterprise">...</Gate>
 *
 * Emerald + blue only — no purple (house rule).
 */
export default function Gate({ capability, tier, fallback = null, children, loadingFallback = null }: GateProps) {
    const ent = useEntitlements();
    if (ent.loading) return loadingFallback;
    if (tier && !ent.hasTier(tier)) return fallback;
    if (capability && !ent.can(capability)) return fallback;
    return <>{children}</>;
}

/** Imperative check for conditional classnames / logic. */
export function useCan(capability: string) {
    const ent = useEntitlements();
    return !ent.loading && ent.can(capability);
}

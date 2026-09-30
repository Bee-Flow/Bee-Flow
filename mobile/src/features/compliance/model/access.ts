/**
 * Who may open the Compliance Center — the web's rule (AdvancedSettings.jsx):
 * the `admin_compliance` permission (org admins hold it; a DPO can be given it
 * without being an admin), then `<RequireTier tier="enterprise"
 * feature="compliance_hub_gdpr">`. The server mounts /api/compliance behind
 * requireModule('compliance') + requireCapability('compliance_hub_gdpr') and
 * every route behind admin_compliance.
 *
 * RequireTier with a feature asks the FEATURE, not the tier, and it fails
 * open while the entitlements resolver is down (the server gate still holds)
 * — so does this: 'unavailable' opens, 'pending' waits, a missing capability
 * locks with the licence reason. The enterprise tier is what the lock names
 * (see `lockedHint`), the capability is what decides.
 */

import { evaluateGate, hasTier, lockHint, type AccessSnapshot, type Gate } from '@/core/access';
import type { TranslateFn } from '@/core/i18n';

export const COMPLIANCE_GATE: Gate = { perms: ['admin_compliance'], can: 'compliance_hub_gdpr', lockOn: 'disable' };

export type ComplianceAccess =
    | { state: 'open' }
    | { state: 'pending' }
    | { state: 'denied' }
    | { state: 'locked'; reason: string | null };

export function complianceAccess(snapshot: AccessSnapshot): ComplianceAccess {
    const gate = evaluateGate(COMPLIANCE_GATE, snapshot);
    if (gate.visible && !gate.locked) return { state: 'open' };
    if (gate.locked) return { state: 'locked', reason: gate.reason };
    switch (gate.reason) {
        case 'pending':
            return { state: 'pending' };
        case 'unavailable':
            return { state: 'open' };
        case 'not_entitled':
            return { state: 'locked', reason: null };
        default:
            return { state: 'denied' };
    }
}

/** The line under a locked hub: the licence reason, or the tier it needs. */
export function lockedHint(access: ComplianceAccess, snapshot: AccessSnapshot, t: TranslateFn): string {
    if (access.state !== 'locked') return '';
    if (access.reason) return lockHint(access.reason, t);
    return hasTier(snapshot, 'enterprise')
        ? lockHint('not_granted', t)
        : t('mobile.compliance.needs_enterprise', 'The Compliance Center is part of the Enterprise plan.');
}

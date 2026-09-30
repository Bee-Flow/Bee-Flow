/**
 * A declarative gate for a row, a screen or a button, and its verdict.
 *
 * The rule is the web's (studioApps.jsx, "Gate resolution: hide vs. lock"):
 *
 * - a PERSON gate — a permission, an admin role, Simple Mode, an installation
 *   feature flag — HIDES what it guards: a member who may not manage agents
 *   should not be shown a door that will not open;
 * - an ENTITLEMENT gate — the licence, the org's canUse map, a capability —
 *   hides by default, but with `lockOn: 'disable'` it shows the thing LOCKED
 *   with the reason, so a Community org learns what App Studio is. It locks
 *   only once the entitlements answer is real; until then (loading, failed,
 *   degraded) it hides, so no licensed org sees "upgrade" on every start.
 *
 * Person gates are checked first: an entitlement lock is a signpost for
 * someone who could use the thing after an upgrade, not for someone whose
 * role keeps them out either way. The server stays the authority throughout.
 */

import type { FeatureFlags } from '@/core/auth/types';

import {
    can,
    canUse,
    featureEnabled,
    hasLicenseFeature,
    holds,
    holdsAny,
    lockReason,
} from './snapshot';
import type { AccessSnapshot, LockReason } from './types';

export interface Gate {
    /** A licence feature (or capability id): LicenseContext.hasFeature. */
    license?: string;
    /** An id in the server's canUseFeature map (licence × beta): makeCanUse. */
    canUse?: string;
    /** A capability id: EntitlementsContext.can. */
    can?: string;
    /** Every one of these permissions. */
    perms?: readonly string[];
    /** At least one of these permissions (an empty list asks nothing). */
    anyPerms?: readonly string[];
    /** The server's org-admin predicate (see roles.isOrgAdmin). */
    orgAdmin?: boolean;
    /** The platform operator only. */
    superAdmin?: boolean;
    /** Hidden in Simple Mode, the personal chat-and-agents-only preference. */
    notSimpleMode?: boolean;
    /** An installation feature flag from /auth/user that must not be off. */
    flag?: keyof FeatureFlags;
    /** What a failed ENTITLEMENT gate does. Person gates always hide. Default 'hide'. */
    lockOn?: 'hide' | 'disable';
}

/** Why a gate hid something that no lock explains. */
export type HideReason =
    | 'super_admin'
    | 'org_admin'
    | 'simple_mode'
    | 'flag_off'
    | 'permission'
    /** The entitlements have not answered yet. */
    | 'pending'
    /** The entitlements answer failed or came back degraded. */
    | 'unavailable'
    /** The entitlements grant it, but the gate's other answer (canUse) says no. */
    | 'not_entitled';

export type GateReason = HideReason | LockReason;

export interface GateResult {
    visible: boolean;
    /** Shown, but disabled: the entitlement is missing and the gate asked to say so. */
    locked: boolean;
    /** Null when open; otherwise why it is hidden or locked. */
    reason: GateReason | null;
}

const OPEN: GateResult = { visible: true, locked: false, reason: null };

/** The first person gate that fails, as the reason it hides. */
function personFailure(gate: Gate, snapshot: AccessSnapshot): HideReason | null {
    if (gate.superAdmin && !snapshot.isSuperAdmin) return 'super_admin';
    if (gate.orgAdmin && !snapshot.isOrgAdmin) return 'org_admin';
    if (gate.notSimpleMode && snapshot.simpleMode) return 'simple_mode';
    if (gate.flag && !featureEnabled(snapshot, gate.flag)) return 'flag_off';
    if (gate.perms && !gate.perms.every((id) => holds(snapshot, id))) return 'permission';
    if (gate.anyPerms?.length && !holdsAny(snapshot, gate.anyPerms)) return 'permission';
    return null;
}

/** The first entitlement the gate names that the snapshot does not grant. */
function missingEntitlement(gate: Gate, snapshot: AccessSnapshot): string | null {
    if (gate.license && !hasLicenseFeature(snapshot, gate.license)) return gate.license;
    if (gate.canUse && !canUse(snapshot, gate.canUse)) return gate.canUse;
    if (gate.can && !can(snapshot, gate.can)) return gate.can;
    return null;
}

function hidden(reason: GateReason): GateResult {
    return { visible: false, locked: false, reason };
}

/** The verdict for one gate against one snapshot. An empty gate is open. */
export function evaluateGate(gate: Gate, snapshot: AccessSnapshot): GateResult {
    const person = personFailure(gate, snapshot);
    if (person) return hidden(person);
    const missing = missingEntitlement(gate, snapshot);
    if (missing === null) return OPEN;
    const reason = lockReason(snapshot, missing);
    if (!reason) {
        if (snapshot.entitlementsState === 'loading') return hidden('pending');
        return hidden(snapshot.entitlementsState === 'ready' ? 'not_entitled' : 'unavailable');
    }
    return gate.lockOn === 'disable' ? { visible: true, locked: true, reason } : hidden(reason);
}

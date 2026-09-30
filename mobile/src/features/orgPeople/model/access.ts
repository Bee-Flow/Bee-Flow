/**
 * Who may use which capability — the rules of the web's GroupAccessMatrix and
 * CeilingReadOnly (agent-hub/src/components/admin/org/), turned from a
 * scope × capability grid into a per-capability list for a phone.
 *
 * Grant-only: a switch GRANTS, there is no per-group "deny". A member gets a
 * capability when it is granted to everyone OR to any group they are in, and
 * only within the org's access menu (`ceiling`); outside it the row is locked.
 */

import type { TranslateFn } from '@/core/i18n';

import type { Capability, CapabilityKind, GroupAccess } from './types';

export const CAPABILITY_KINDS: readonly CapabilityKind[] = ['core', 'beta', 'integration'];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
    return typeof value === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(value);
}

export function kindLabel(kind: string, t: TranslateFn): string {
    if (kind === 'beta') return t('mobile.orgPeople.kind_beta', 'Beta features');
    if (kind === 'integration') return t('mobile.orgPeople.kind_integration', 'Integrations');
    return t('mobile.orgPeople.kind_core', 'Features');
}

export interface CapabilitySection {
    kind: CapabilityKind;
    data: Capability[];
}

/** Category then name, as the web sorts each kind. */
function byCategoryThenName(a: Capability, b: Capability): number {
    return (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name);
}

/** The capabilities of each kind, in kind order, empty kinds left out. */
export function sectionsByKind(
    capabilities: readonly Capability[],
    kinds: readonly CapabilityKind[] = CAPABILITY_KINDS,
    keep: (cap: Capability) => boolean = () => true,
): CapabilitySection[] {
    return kinds
        .map((kind) => ({
            kind,
            data: capabilities.filter((c) => c.kind === kind && keep(c)).sort(byCategoryThenName),
        }))
        .filter((s) => s.data.length > 0);
}

/** CeilingReadOnly: what the org has access to, per kind, empty kinds kept. */
export function ceilingByKind(access: GroupAccess): CapabilitySection[] {
    const ceiling = new Set(access.ceiling);
    return CAPABILITY_KINDS.map((kind) => ({
        kind,
        data: access.capabilities
            .filter((c) => c.kind === kind && ceiling.has(c.id))
            .sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

export function isLocked(access: GroupAccess, capId: string): boolean {
    return !access.ceiling.includes(capId);
}

/** On cloud a beta follows the subscription: on for everyone, not a switch here. */
export function isGoverned(access: GroupAccess, cap: Capability): boolean {
    return cap.kind === 'beta' && access.betaGoverned;
}

export interface ScopeState {
    checked: boolean;
    readOnly: boolean;
    /** A group row that is on because everyone has it. */
    inherited: boolean;
}

export function everyoneState(access: GroupAccess, cap: Capability): ScopeState {
    const governed = isGoverned(access, cap);
    return {
        checked: governed || access.everyone.includes(cap.id),
        readOnly: governed || isLocked(access, cap.id),
        inherited: false,
    };
}

export function groupState(access: GroupAccess, cap: Capability, groupId: string): ScopeState {
    const inherited = isGoverned(access, cap) || access.everyone.includes(cap.id);
    const own = access.groups.find((g) => g.id === groupId)?.granted.includes(cap.id) ?? false;
    return {
        checked: inherited || own,
        readOnly: inherited || isLocked(access, cap.id),
        inherited,
    };
}

/**
 * The whole list to PUT for a scope with one capability switched. The server
 * REPLACES that scope's grants across every kind, so the list must carry the
 * grants this screen is not showing too.
 */
export function withGrant(current: readonly string[], capId: string, on: boolean): string[] {
    const rest = current.filter((id) => id !== capId);
    return on ? [...rest, capId] : rest;
}

/** Optimistic copies of the payload after one switch. */
export function applyEveryone(access: GroupAccess, granted: string[]): GroupAccess {
    return { ...access, everyone: granted };
}

export function applyGroup(access: GroupAccess, groupId: string, granted: string[]): GroupAccess {
    return { ...access, groups: access.groups.map((g) => (g.id === groupId ? { ...g, granted } : g)) };
}

/** "Everyone" / "3 groups" / "Nobody": who holds a capability, for its list row. */
export function holdersSummary(access: GroupAccess, cap: Capability, t: TranslateFn): string {
    if (isLocked(access, cap.id)) return t('mobile.orgPeople.access_locked', 'Outside your organisation’s access');
    if (everyoneState(access, cap).checked) return t('mobile.orgPeople.access_everyone', 'All members');
    const groups = access.groups.filter((g) => g.granted.includes(cap.id)).length;
    if (groups === 0) return t('mobile.orgPeople.access_nobody', 'Not granted');
    return groups === 1
        ? t('mobile.orgPeople.access_one_group', '1 group')
        : t('mobile.orgPeople.access_groups', '{count} groups', { count: groups });
}

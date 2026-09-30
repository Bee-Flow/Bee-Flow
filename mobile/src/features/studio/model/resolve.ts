/**
 * From "the registry" to "the rows a person sees": the web's
 * resolveStudioNav / studioNavSections / groupStudioApps / firstOpenStudioSection
 * (studioApps.jsx, studioNav.js) and the Sidebar's canSeeStudio, as pure
 * functions over a core/access snapshot. The drawer, the Studio tab and the
 * hub all answer the gate question here, so they cannot answer it three ways.
 */

import {
    can,
    canUse,
    hasLicenseFeature,
    holds,
    lockReason,
    type AccessSnapshot,
} from '@/core/access';

import { STUDIO_CATEGORIES, STUDIO_SECTIONS } from './registry';
import type { ResolvedSection, StudioGroup, StudioSection } from './types';

/** Every id in every list of the section's gate passes. */
export function passesGate(section: StudioSection, snapshot: AccessSnapshot): boolean {
    const { license = [], canUse: programme = [], can: capabilities = [], perms = [] } = section.requires;
    return (
        license.every((id) => hasLicenseFeature(snapshot, id)) &&
        programme.every((id) => canUse(snapshot, id)) &&
        capabilities.every((id) => can(snapshot, id)) &&
        perms.every((id) => holds(snapshot, id))
    );
}

/**
 * The gate-passing sections plus the locked ones. A failed gate locks only
 * when the section opts in (`lockOn: 'disable'`) AND the entitlement it names
 * answers with a reason; `lockReason` is null while the entitlements are still
 * loading or failed (and when the entitlement IS effective, so the failing leg
 * must be a permission) — both of which hide, exactly as on the web.
 */
export function resolveSections(
    snapshot: AccessSnapshot,
    sections: readonly StudioSection[] = STUDIO_SECTIONS,
): ResolvedSection[] {
    const out: ResolvedSection[] = [];
    for (const section of sections) {
        if (passesGate(section, snapshot)) {
            out.push({ ...section, locked: null });
            continue;
        }
        if (section.lockOn !== 'disable' || !section.gateCapability) continue;
        const reason = lockReason(snapshot, section.gateCapability);
        if (reason) out.push({ ...section, locked: reason });
    }
    return out;
}

/** The Studio group's rows: resolved, minus the sections with their own entrance. */
export function studioNavSections(snapshot: AccessSnapshot): ResolvedSection[] {
    return resolveSections(snapshot).filter((s) => !s.hiddenFromNav);
}

/** Grouped under the category headings, in STUDIO_CATEGORIES order, empty groups skipped. */
export function groupSections(sections: readonly ResolvedSection[]): StudioGroup[] {
    const known = new Set(STUDIO_CATEGORIES.map((c) => c.id));
    return STUDIO_CATEGORIES.map((category) => ({
        category,
        sections: sections.filter((s) => (known.has(s.category) ? s.category : 'modules') === category.id),
    })).filter((group) => group.sections.length > 0);
}

/** Where the Studio row itself lands: the first section that is not locked. */
export function firstOpenSection(sections: readonly ResolvedSection[]): ResolvedSection | null {
    return sections.find((s) => !s.locked) ?? null;
}

/**
 * Who gets Studio at all — the web Sidebar's canSeeStudio, minus `isMobile`
 * (the web hides Studio on a phone-width browser; this app IS the phone, and
 * brings Studio natively). Simple Mode still hides it, a builder permission or
 * an admin role still earns it, and there must be something in it to open.
 */
export function canSeeStudio(snapshot: AccessSnapshot, sections: readonly ResolvedSection[]): boolean {
    if (snapshot.simpleMode) return false;
    const perms = snapshot.permissions;
    const builder =
        snapshot.isSuperAdmin ||
        perms.includes('all') ||
        perms.includes('manage_agents') ||
        perms.includes('manage_skills') ||
        snapshot.orgRole === 'admin' ||
        snapshot.orgRole === 'org_admin';
    return builder && sections.length > 0;
}

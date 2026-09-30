/**
 * navModel(definition): the ONE place that turns definition.screens and
 * definition.nav.groups into what an app's navigation renders. Port of
 * agent-hub AppStudio/runtime/shell/navModel.js (the server's
 * resolveNavScreens in appDesignSpec.js is the same rule).
 *
 *   - screens with showInNav === false never appear;
 *   - a screen listed in a group leaves the ungrouped list;
 *   - a screen claimed by an earlier group is skipped in later ones;
 *   - refs to unknown/hidden screens are dropped, and so are empty groups;
 *   - order: ungrouped screens in definition order, then grouped screens in
 *     group order (also the flattened tabs order).
 */

import type { AppDefinition, AppScreen } from '../types';

export interface NavGroup {
    id: unknown;
    label: unknown;
    icon: unknown;
    screens: AppScreen[];
}

export interface NavModel {
    ungrouped: AppScreen[];
    groups: NavGroup[];
    flat: AppScreen[];
}

export function navModel(definition: AppDefinition | null | undefined): NavModel {
    const navScreens = (definition?.screens || []).filter((s) => s && s.showInNav !== false);
    const byId = new Map(navScreens.map((s) => [s.id, s]));
    const rawGroups = Array.isArray(definition?.nav?.groups) ? (definition.nav.groups as unknown[]) : [];
    const claimed = new Set<unknown>();
    const groups: NavGroup[] = [];
    for (const raw of rawGroups) {
        if (!raw || typeof raw !== 'object') continue;
        const g = raw as { id?: unknown; label?: unknown; icon?: unknown; screens?: unknown };
        const members: AppScreen[] = [];
        for (const ref of Array.isArray(g.screens) ? g.screens : []) {
            const screen = claimed.has(ref) ? undefined : byId.get(ref as string);
            if (!screen) continue;
            claimed.add(ref);
            members.push(screen);
        }
        if (members.length) groups.push({ id: g.id, label: g.label, icon: g.icon || null, screens: members });
    }
    const ungrouped = navScreens.filter((s) => !claimed.has(s.id));
    return { ungrouped, groups, flat: [...ungrouped, ...groups.flatMap((g) => g.screens)] };
}

/**
 * The drawer's fixed rows — the web Sidebar's `coreNav` and `secondaryNav`
 * (agent-hub/src/components/shell/Sidebar.jsx), in its order, with its i18n
 * keys and its Lucide glyphs. sidebarNav.lockstep.test.ts reads the web file
 * and fails when either list moves on without this one.
 *
 * Only the SPEC lives here, still the web's two lists in full. The phone's
 * drawer draws New Chat, Approvals (conditional), Search and Agents from
 * them; Cowork, Studio, Apps, Forms and Notebooks open from the Studio tab
 * instead (hooks/useWorkspaceLinks and the Studio registry).
 */

import type { StudioAppMeta } from '@/features/apps';
import type { IconName } from '@/shared/ui';

export interface NavSpec {
    /** The web's row key. */
    key: string;
    labelKey: string;
    labelFallback: string;
    icon: IconName;
    /** Where the row opens on the phone. */
    href: string;
}

/** Pinned at the top of the drawer: ask, delegate, decide, find. */
export const CORE_NAV = [
    { key: 'new-chat', labelKey: 'sidebar.new_chat', labelFallback: 'New Chat', icon: 'PenLine', href: '/' },
    { key: 'cowork', labelKey: 'sidebar.cowork', labelFallback: 'Cowork', icon: 'Handshake', href: '/cowork' },
    { key: 'approvals', labelKey: 'sidebar.approvals', labelFallback: 'Approvals', icon: 'ShieldCheck', href: '/approvals' },
    { key: 'search', labelKey: 'sidebar.search', labelFallback: 'Search', icon: 'Search', href: '/search' },
] as const satisfies readonly NavSpec[];

/** Below the pinned rows, scrolling with the rest: the directory, the builder, the things built. */
export const SECONDARY_NAV = [
    { key: 'agents', labelKey: 'sidebar.agents', labelFallback: 'Agents', icon: 'Store', href: '/agents' },
    { key: 'studio', labelKey: 'studio.sidebar_link', labelFallback: 'Studio', icon: 'LayoutGrid', href: '/studio' },
    { key: 'apps', labelKey: 'sidebar.apps', labelFallback: 'Apps', icon: 'AppWindow', href: '/apps' },
    { key: 'forms', labelKey: 'sidebar.forms', labelFallback: 'Forms', icon: 'ClipboardList', href: '/forms' },
] as const satisfies readonly NavSpec[];

export type CoreKey = (typeof CORE_NAV)[number]['key'];
export type SecondaryKey = (typeof SECONDARY_NAV)[number]['key'];

export function coreSpec(key: CoreKey): NavSpec {
    return CORE_NAV.find((row) => row.key === key) as NavSpec;
}

export function secondarySpec(key: SecondaryKey): NavSpec {
    return SECONDARY_NAV.find((row) => row.key === key) as NavSpec;
}

/**
 * How many rows a drawer list draws before its "All …" row takes over. The
 * drawer's header is one un-windowed block above the virtualised chats, so a
 * list in it needs a bound; the web's own Forms flyout stops at five.
 */
export const DRAWER_LIST_CAP = 8;

/** The published apps someone can open, alphabetically (a list should not reshuffle every time someone saves). */
export function publishedApps(apps: readonly StudioAppMeta[]): StudioAppMeta[] {
    return apps
        .filter((app) => app.isPublished)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

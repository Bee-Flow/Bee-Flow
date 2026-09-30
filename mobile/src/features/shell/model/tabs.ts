/**
 * The slim bottom bar under the drawer: up to three tabs, the three things a
 * phone is for — ask (Chat), capture (Meeting Notes) and everything else you
 * use and build (Studio). Capture sits in the middle, under the thumb; Studio,
 * the way into everything else, sits at the edge.
 *
 * Studio is everyone's: its Workspace group (Cowork, Apps, Forms, Notebooks)
 * is what a member opens, and the builder sections below it show only to
 * someone the web shows Studio to (canSeeStudio). Meeting Notes is that Studio
 * section's capture flow, so it takes that section's gate (licence,
 * programme, use_meeting_notes) — its API 403s without them. A tab not offered
 * is hidden from the bar (`href: null`) but stays routable, so a deep link
 * still lands inside the drawer.
 *
 * Cowork and the Apps directory used to be tabs of their own; they are pushed
 * screens now (app/cowork, app/apps), opened from Studio.
 */

import type { IconName } from '@/shared/ui';

export interface TabSpec {
    /** The route file's name under app/(drawer)/(tabs)/. */
    name: 'index' | 'studio' | 'record';
    /** Its URL. */
    path: string;
    labelKey: string;
    labelFallback: string;
    icon: IconName;
}

export const TABS: readonly TabSpec[] = [
    { name: 'index', path: '/', labelKey: 'mobile.tabs.chat', labelFallback: 'Chat', icon: 'MessageSquare' },
    { name: 'record', path: '/record', labelKey: 'studio.tab.meeting_notes', labelFallback: 'Meeting Notes', icon: 'Mic' },
    { name: 'studio', path: '/studio', labelKey: 'studio.sidebar_link', labelFallback: 'Studio', icon: 'LayoutGrid' },
];

/**
 * Every path that renders inside the drawer; any other screen is pushed over
 * it. The same set as shared/navigation's DRAWER_PATHS (tabs.test.ts).
 */
export const TAB_PATHS: ReadonlySet<string> = new Set(TABS.map((tab) => tab.path));

/** What this session is offered, per conditional tab (hooks/useTabOffer). */
export interface TabOffer {
    /** The Meeting Notes gate. */
    record: boolean;
}

/** Whether a tab is in the bar: Chat and Studio always, Meeting Notes behind its gate. */
export function tabShown(tab: TabSpec, offer: TabOffer): boolean {
    return tab.name === 'record' ? offer.record : true;
}

/** A navigator state as far as this reads it: routes by name, and which is focused. */
interface NavState {
    index?: number;
    routes: readonly { name: string; state?: NavState }[];
}

/**
 * The tab the drawer holds, from the drawer navigator's own state: its one
 * route is the tab group, whose focused route is the tab. A screen pushed over
 * the drawer does not change it, so the drawer's "current" row stays put.
 * A state not yet rehydrated has no index; its last route is the focused one.
 */
export function tabPathOf(drawer: NavState | undefined): string {
    const focus = (state: NavState | undefined) =>
        state ? state.routes[state.index ?? state.routes.length - 1] : undefined;
    const tab = focus(focus(drawer)?.state);
    return TABS.find((spec) => spec.name === tab?.name)?.path ?? '/';
}

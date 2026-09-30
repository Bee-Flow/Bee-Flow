/**
 * The sections of one Solution's object screen.
 *
 * The first six are the web's SolutionDetail tabs, in its order (Content,
 * Check, Versions, Installs, Flow, Overview); the last three are the
 * collaboration half the web keeps on its project page (Chats, Members,
 * Activity) — on a phone they are one object, so one tab strip.
 *
 * Versions and Installs are shown only to the owner on a plan with Blueprint
 * packaging: both routes are owner-only and licence-gated, so for anyone else
 * the tab could only ever say "could not be read".
 */

export const SOLUTION_TABS = ['content', 'control', 'versions', 'installs', 'flow', 'overview', 'chats', 'members', 'activity'] as const;

export type SolutionTab = (typeof SOLUTION_TABS)[number];

export function isSolutionTab(value: unknown): value is SolutionTab {
    return typeof value === 'string' && (SOLUTION_TABS as readonly string[]).includes(value);
}

export function visibleTabs({ isOwner, packaging }: { isOwner: boolean; packaging: boolean }): SolutionTab[] {
    const history = isOwner && packaging;
    return SOLUTION_TABS.filter((tab) => (tab === 'versions' || tab === 'installs' ? history : true));
}

/** The tab to show: the one asked for when it is visible, else Content. */
export function activeTab(wanted: SolutionTab, visible: readonly SolutionTab[]): SolutionTab {
    return visible.includes(wanted) ? wanted : 'content';
}

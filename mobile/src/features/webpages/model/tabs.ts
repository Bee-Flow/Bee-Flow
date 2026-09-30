/**
 * The page screen's sections. Preview comes first and is where a page is
 * made: the rendered page, with the AI builder's composer under it (the web
 * keeps its builder chat open beside everything else). The rest are the web
 * editor's other areas — History, Data & links, Knowledge — plus the publish
 * dialog (Share) and the page's own settings.
 *
 * There is no Code section: the phone makes pages by asking, not by typing
 * source. An old link that asks for `build` or `code` lands on Preview.
 *
 * An org viewer — someone the page was published to — may look at the page
 * and see how it is shared; everything else is owner-only on the server.
 */

import { translate } from '@/core/i18n';
import type { TabBarItem } from '@/shared/ui';

export const WEBPAGE_TABS = ['preview', 'history', 'data', 'knowledge', 'share', 'settings'] as const;
export type WebpageTab = (typeof WEBPAGE_TABS)[number];

const VIEWER_TABS: readonly WebpageTab[] = ['preview', 'share'];

export function tabsFor(readOnly: boolean): WebpageTab[] {
    return readOnly ? [...VIEWER_TABS] : [...WEBPAGE_TABS];
}

/** A `?tab=` from a link, if it names a section this person has; else Preview. */
export function initialTab(param: string | undefined, readOnly: boolean): WebpageTab {
    const tabs = tabsFor(readOnly);
    return tabs.includes(param as WebpageTab) ? (param as WebpageTab) : 'preview';
}

export function tabItems(readOnly: boolean, counts: { sources?: number | null } = {}): TabBarItem<WebpageTab>[] {
    const labels: Record<WebpageTab, string> = {
        preview: translate('webpages.preview.title', 'Preview'),
        knowledge: translate('mobile.webpages.tab.knowledge', 'Knowledge'),
        history: translate('webpages.tab.history', 'History'),
        data: translate('mobile.webpages.tab.data', 'Data & links'),
        share: translate('mobile.webpages.tab.share', 'Share'),
        settings: translate('mobile.webpages.tab.settings', 'Settings'),
    };
    return tabsFor(readOnly).map((id) => ({
        id,
        label: labels[id],
        ...(id === 'knowledge' && counts.sources ? { count: counts.sources } : {}),
    }));
}

import type { ComponentProps } from 'react';
import AppIcon from '@/components/icons/AppIcon';
import AnnouncementEditor from '../blockEditors/AnnouncementEditor';
import type { BlockData } from '../blockEditors/shared';
import CookieBannerEditor from '../CookieBannerEditor';
import { HeaderEditor, FooterEditor } from '../editors';
import type { CmsPageOption } from '../fields';
import type { CmsLocale, CmsSiteDoc } from '../panel/cmsPanelTypes';
import {
    HEADER_VIRTUAL_ID, FOOTER_VIRTUAL_ID, COOKIE_VIRTUAL_ID, ANNOUNCE_VIRTUAL_ID,
} from '../sentinels';

const META: Record<string, { icon: string; title: string; note: string }> = {
    [HEADER_VIRTUAL_ID]: {
        icon: 'LayoutTemplate', title: 'Header',
        note: 'The header is shared across all pages.',
    },
    [FOOTER_VIRTUAL_ID]: {
        icon: 'PanelBottom', title: 'Footer',
        note: 'The footer is shared across all pages.',
    },
    [COOKIE_VIRTUAL_ID]: {
        icon: 'Cookie', title: 'Cookie banner',
        note: 'Shown site-wide until the visitor accepts or declines.',
    },
    [ANNOUNCE_VIRTUAL_ID]: {
        icon: 'Megaphone', title: 'Announcement bar',
        note: 'A short strip above the header, on every page. Off by default.',
    },
};

/**
 * Chrome inspector — ONE chrome surface at a time (header / footer / cookie
 * banner / announcement bar), selected via the navigator's Site group. All
 * edits keep flowing through `onChangeSite` → updateSiteChrome → the shared
 * 'site' save slot.
 */
interface ChromeInspectorProps {
    entryId: string | null;
    site: CmsSiteDoc | null;
    locales: CmsLocale[];
    onChangeSite: (next: CmsSiteDoc) => void;
    pages: CmsPageOption[];
    defaultLocale: string;
}

export default function ChromeInspector({ entryId, site, pages, locales, defaultLocale, onChangeSite }: ChromeInspectorProps) {
    if (!site) return null;
    const meta = META[entryId as string] || META[HEADER_VIRTUAL_ID];

    const setHeader = (h: BlockData) => onChangeSite({ ...site, header: h });
    const setFooter = (f: BlockData) => onChangeSite({ ...site, footer: f });
    const setCookieBanner = (c: BlockData) => onChangeSite({ ...site, cookieBanner: c });
    const setAnnouncement = (a: BlockData) => onChangeSite({ ...site, announcement: a });

    return (
        <div className="h-full overflow-y-auto">
            <div className="px-4 pt-4 pb-2">
                <div className="flex items-center gap-2 mb-1">
                    <AppIcon name={meta.icon} className="w-4 h-4 text-[var(--accent-primary)]" />
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{meta.title}</span>
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-4">{meta.note}</p>
                {entryId === FOOTER_VIRTUAL_ID ? (
                    <FooterEditor data={site.footer as ComponentProps<typeof FooterEditor>['data']} pages={pages} onChange={setFooter} />
                ) : entryId === COOKIE_VIRTUAL_ID ? (
                    <CookieBannerEditor
                        data={site.cookieBanner as ComponentProps<typeof CookieBannerEditor>['data']}
                        onChange={setCookieBanner}
                        locales={locales}
                        defaultLocale={defaultLocale}
                    />
                ) : entryId === ANNOUNCE_VIRTUAL_ID ? (
                    <AnnouncementEditor
                        data={site.announcement as ComponentProps<typeof AnnouncementEditor>['data']}
                        onChange={setAnnouncement}
                        locales={locales}
                        defaultLocale={defaultLocale}
                    />
                ) : (
                    <HeaderEditor data={site.header as ComponentProps<typeof HeaderEditor>['data']} pages={pages} onChange={setHeader} />
                )}
            </div>
        </div>
    );
}

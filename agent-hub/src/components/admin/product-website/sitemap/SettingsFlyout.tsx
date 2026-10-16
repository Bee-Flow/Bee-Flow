import { useMemo, useRef, useState } from 'react';
import { ensureOk } from './sitemapGraph';
import type { SitemapPage, SitemapSite } from './sitemapGraph';
import useAsyncAction from '../../../../hooks/useAsyncAction';
import useOutsideDismiss from '../../../../hooks/useOutsideDismiss';
import { useTranslation } from '../../../../hooks/useTranslation';
import { slugIssues as slugIssuesJs } from '../../../../utils/cmsPublicRouting';
import { authFetch } from '../../../../utils/helpers';
import useConfirm from '../../../shared/useConfirm';
import { AppIcon } from '../blog/jsComponents';
import { cmsApi } from '../cmsApi';

// cmsPublicRouting is plain JS; its `= null` option defaults read as "always null".
const slugIssues = slugIssuesJs;

const FLYOUT_W = 280;

interface SettingsFlyoutProps {
    page: SitemapPage;
    pages: SitemapPage[];
    site: SitemapSite;
    siteId: string;
    anchorPos: { x: number; y: number };
    canvasWidth: number;
    onClose: () => void;
    onChanged: () => void;
    onOpenInEditor: () => void;
}

const isNavEntryFor = (pageId: string) => (n: { link?: { kind?: string; pageId?: string } } | null) =>
    n?.link?.kind === 'page' && n.link.pageId === pageId;

/**
 * The flyout's writes: title/slug, nav membership, homepage, delete. Each
 * goes straight to the server and ends in `onChanged`. One shared async
 * runner — `busy` gates the whole form, `error` surfaces the last failure,
 * `run` never throws.
 */
function useSitemapPageActions({ page, site, siteId, onChanged }: Pick<SettingsFlyoutProps, 'page' | 'site' | 'siteId' | 'onChanged'>) {
    const { confirm, confirmDialog } = useConfirm();
    const { run, loading: busy, error } = useAsyncAction((task: () => Promise<void>) => task());

    const saveMeta = (patch: { title?: string; slug?: string }) => run(async () => {
        const res = await authFetch(cmsApi.pageMeta(siteId, page.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        await ensureOk(res, 'Save failed');
        onChanged();
    });

    // "Show in nav" maps to adding/removing a nav item pointing at this page.
    // We mutate the full site doc and PUT it back.
    const toggleNav = (next: boolean) => run(async () => {
        const navItems = site?.header?.nav || [];
        let nextNav;
        if (next) {
            // Add an entry if there isn't one already.
            nextNav = navItems.some(isNavEntryFor(page.id)) ? navItems : [
                ...navItems,
                {
                    id: `nav_${Math.random().toString(36).slice(2, 8)}`,
                    label: page.title || page.slug || 'Page',
                    link: { kind: 'page', pageId: page.id },
                },
            ];
        } else {
            nextNav = navItems.filter(n => !isNavEntryFor(page.id)(n));
        }
        const nextSite = { ...site, header: { ...(site.header || {}), nav: nextNav } };
        const res = await authFetch(cmsApi.site(siteId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site: nextSite }),
        });
        await ensureOk(res, 'Save failed');
        onChanged();
    });

    const setHomepage = () => run(async () => {
        const res = await authFetch(cmsApi.pageHomepage(siteId, page.id), { method: 'PUT' });
        await ensureOk(res, 'Save failed');
        onChanged();
    });

    const deletePage = async () => {
        if (!(await confirm({ title: `Delete page "${page.title || page.slug}"?`, description: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true }))) return;
        run(async () => {
            const res = await authFetch(cmsApi.page(siteId, page.id), { method: 'DELETE' });
            await ensureOk(res, 'Delete failed');
            onChanged();
        });
    };

    return { busy, error: error as Error | null, saveMeta, toggleNav, setHomepage, deletePage, confirmDialog };
}

function NavSwitch({ on, busy, onToggle }: { on: boolean; busy: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-[var(--text-secondary)]">{t('cms_site.site.sitemap.show_in_nav', 'Show in nav')}</span>
            <button
                type="button"
                onClick={onToggle}
                disabled={busy}
                role="switch"
                aria-checked={on}
                className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors
                    ${on ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-default)]'}
                    ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
                <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow
                        ${on ? 'translate-x-4' : 'translate-x-0.5'}`}
                />
            </button>
        </div>
    );
}

function DangerRow({ page, pages, busy, onSetHomepage, onDelete }: { page: SitemapPage; pages: SitemapPage[]; busy: boolean; onSetHomepage: () => void; onDelete: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="border-t border-[var(--border-subtle)] pt-2.5 flex items-center justify-between gap-2">
            <button
                type="button"
                onClick={onSetHomepage}
                disabled={busy || page.isHomepage}
                className="text-xs text-[var(--text-secondary)] hover:text-[var(--accent-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                title={page.isHomepage ? t('cms_site.site.sitemap.already_home', 'Already the homepage') : t('cms_site.site.sitemap.promote_home', 'Promote to homepage')}
            >
                {t('cms_site.site.sitemap.set_homepage', 'Set as homepage')}
            </button>
            <button
                type="button"
                onClick={onDelete}
                disabled={busy || (page.isHomepage && pages.length > 1)}
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                title={page.isHomepage && pages.length > 1
                    ? t('cms_site.site.sitemap.promote_first', 'Promote another page to homepage first')
                    : t('cms_site.site.sitemap.delete_this', 'Delete this page')}
            >
                {t('cms_site.site.sitemap.delete_page', 'Delete page')}
            </button>
        </div>
    );
}

const FIELD = 'px-2 py-1.5 rounded text-xs border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]';
const FIELD_LABEL = 'text-[10px] uppercase tracking-wider text-[var(--text-muted)]';

/** A page's settings, opened from its card's gear. */
export default function SettingsFlyout({ page, pages, site, siteId, anchorPos, canvasWidth, onClose, onChanged, onOpenInEditor }: SettingsFlyoutProps) {
    const { t } = useTranslation();
    const [title, setTitle] = useState(page.title || '');
    const [slug, setSlug]   = useState(page.slug  || '');
    const { busy, error, saveMeta, toggleNav, setHomepage, deletePage, confirmDialog } = useSitemapPageActions({ page, site, siteId, onChanged });
    const ref = useRef<HTMLDivElement | null>(null);

    // In-nav membership lives on the site doc's header.nav, not on the page
    // itself: a page-kind nav entry pointing at this page.
    const inNav = useMemo(() => (site?.header?.nav || []).some(isNavEntryFor(page.id)), [site, page.id]);

    // Close on Escape / click outside.
    useOutsideDismiss(ref, onClose);

    // Anchor — clamp so the flyout doesn't overflow the canvas on the right.
    const clampedLeft = Math.min(anchorPos.x, Math.max(0, canvasWidth - FLYOUT_W - 16));

    // Reserved slugs / duplicates block the save (server rejects reserved,
    // and would silently -2-suffix a duplicate); `_` slugs warn only.
    const slugIssue = slugIssues(slug, {
        existingSlugs: (pages || []).map(pg => pg.slug),
        currentSlug: page.slug,
    });

    const handleSaveMeta = () => {
        const titleChanged = title.trim() !== page.title;
        const slugChanged  = slug.trim()  !== page.slug;
        if (slugChanged && slugIssue?.blocking) return;
        if (!titleChanged && !slugChanged) { onClose(); return; }
        const patch: { title?: string; slug?: string } = {};
        if (titleChanged) patch.title = title.trim();
        if (slugChanged)  patch.slug  = slug.trim();
        saveMeta(patch);
    };

    return (
        <div
            ref={ref}
            style={{ position: 'absolute', left: clampedLeft, top: anchorPos.y, width: FLYOUT_W, zIndex: 80 }}
            className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]">
                <span className="text-xs font-semibold text-[var(--text-primary)]">{t('cms_site.site.sitemap.page_settings', 'Page settings')}</span>
                <button type="button" onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]" title={t('cms_site.site.sitemap.close', 'Close')}>
                    <AppIcon name="X" className="w-3.5 h-3.5" />
                </button>
            </div>
            <div className="p-3 flex flex-col gap-2.5">
                <label className="flex flex-col gap-1">
                    <span className={FIELD_LABEL}>{t('cms_site.site.sitemap.title', 'Title')}</span>
                    <input type="text" value={title} onChange={e => setTitle(e.target.value)} disabled={busy} className={FIELD} />
                </label>
                <label className="flex flex-col gap-1">
                    <span className={FIELD_LABEL}>{t('cms_site.site.sitemap.slug', 'Slug')}</span>
                    <input
                        type="text"
                        value={slug}
                        onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                        disabled={busy}
                        className={`${FIELD} font-mono`}
                    />
                    {slugIssue ? (
                        <span className={`text-[10px] leading-tight ${slugIssue.blocking ? 'text-red-400' : 'text-amber-500/90'}`}>
                            ⚠ {slugIssue.message}
                        </span>
                    ) : null}
                </label>
                <NavSwitch on={inNav} busy={busy} onToggle={() => toggleNav(!inNav)} />
                {error ? <p className="text-xs text-red-400">{error.message}</p> : null}

                <div className="flex items-center gap-2 pt-1">
                    <button
                        type="button"
                        onClick={handleSaveMeta}
                        disabled={busy || (slug.trim() !== page.slug && !!slugIssue?.blocking)}
                        className="flex-1 px-3 py-1.5 text-xs rounded-md bg-[var(--accent-primary)] text-white disabled:opacity-50"
                    >
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                    <button
                        type="button"
                        onClick={onOpenInEditor}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)]/60 hover:text-[var(--accent-primary)] disabled:opacity-50"
                    >
                        {t('cms_site.site.sitemap.open_in_editor', 'Open in editor')}
                    </button>
                </div>

                <DangerRow page={page} pages={pages} busy={busy} onSetHomepage={setHomepage} onDelete={deletePage} />
            </div>
            {confirmDialog}
        </div>
    );
}

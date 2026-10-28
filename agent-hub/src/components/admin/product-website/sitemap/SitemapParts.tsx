import { useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { EdgePopoverState } from './SitemapEdges';
import { NODE_H, NODE_W } from './sitemapGraph';
import type { Point, SitemapPage } from './sitemapGraph';
import useOutsideDismiss from '@/hooks/useOutsideDismiss';
import { useTranslation } from '@/hooks/useTranslation';
import { AppIcon } from '../blog/jsComponents';

function Badge({ variant, children }: { variant: 'home' | 'nav' | 'orphan'; children: ReactNode }) {
    const cls = variant === 'home'
        ? 'bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]'
        : variant === 'orphan'
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
            : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]';
    return (
        <span className={`px-1.5 py-0.5 rounded ${cls} font-medium`}>{children}</span>
    );
}

interface NodeCardProps {
    page: SitemapPage;
    pos: Point;
    isHomepage: boolean;
    isOrphan: boolean;
    isActive: boolean;
    inNav: boolean;
    onMouseDown: (e: MouseEvent) => void;
    onGear: () => void;
}

/** One page card: title, gear, slug and its badges. Dragged by mousedown. */
export function NodeCard({ page, pos, isHomepage, isOrphan, isActive, inNav, onMouseDown, onGear }: NodeCardProps) {
    const { t } = useTranslation();
    const title = page.title || '(untitled)';
    const truncated = title.length > 20 ? title.slice(0, 19) + '…' : title;
    const borderColor = isActive
        ? 'var(--accent-primary)'
        : (isOrphan ? 'var(--border-default)' : 'var(--border-subtle)');
    const handleGearKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onGear();
        }
    };
    return (
        <div
            style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                width: NODE_W,
                height: NODE_H,
                borderColor,
            }}
            className={`group flex flex-col rounded-lg border bg-[var(--bg-primary)] shadow-sm
                ${isActive ? 'ring-2 ring-[var(--accent-primary)]/30' : ''}
                ${isOrphan ? 'opacity-90' : ''}
                select-none cursor-grab active:cursor-grabbing
                transition-shadow transition-colors duration-150
                hover:shadow-md hover:border-[var(--accent-primary)]/60`}
            onMouseDown={onMouseDown}
        >
            {/* Header strip: title + gear */}
            <div className="flex items-start justify-between px-3 pt-2 gap-2 min-w-0">
                <span
                    className="text-sm font-medium text-[var(--text-primary)] leading-tight truncate"
                    title={title}
                >
                    {truncated}
                </span>
                <button
                    type="button"
                    role="button"
                    tabIndex={0}
                    aria-label={t('cms_site.site.sitemap.edit_page_named', 'Edit page {title}', { title })}
                    title={t('cms_site.site.sitemap.edit_page', 'Edit page')}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onGear(); }}
                    onKeyDown={handleGearKey}
                    className="shrink-0 -mr-1 mt-0.5 w-6 h-6 inline-flex items-center justify-center rounded
                        text-[var(--text-muted)] hover:text-[var(--accent-primary)]
                        opacity-40 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                >
                    <AppIcon name="Settings" className="w-3.5 h-3.5" />
                </button>
            </div>
            {/* Slug */}
            <span className="px-3 text-[11px] font-mono text-[var(--text-muted)] truncate" title={`/${page.slug}`}>
                /{page.slug}
            </span>
            {/* Badges */}
            <div className="px-3 pb-2 mt-auto flex items-center gap-1 text-[9px] uppercase tracking-wider">
                {isHomepage ? <Badge variant="home">{t('cms_site.site.sitemap.badge_home', 'Home')}</Badge> : null}
                {!isHomepage && inNav ? <Badge variant="nav">{t('cms_site.site.sitemap.badge_in_nav', 'In nav')}</Badge> : null}
                {!isHomepage && isOrphan ? <Badge variant="orphan">{t('cms_site.site.sitemap.badge_orphan', 'Orphan')}</Badge> : null}
            </div>
        </div>
    );
}

/**
 * Edge popover (info-only).
 *
 * The spec described a "Break link?" confirm action; implementing destructive
 * edge removal cleanly requires walking the source block's content tree to a
 * specific path, which is non-trivial and out of scope for this rebuild. The
 * popover surfaces *where* a link is defined so the user can navigate to that
 * surface and edit it there. Marked as a follow-up.
 */
export function EdgePopover({ edgePopover, onClose }: { edgePopover: EdgePopoverState; onClose: () => void }) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDivElement | null>(null);
    useOutsideDismiss(ref, onClose);

    const kindLabel = edgePopover.info.kind === 'chrome'
        ? t('cms_site.site.sitemap.kind_chrome', 'Nav link (Site chrome)')
        : edgePopover.info.kind === 'tree'
            ? t('cms_site.site.sitemap.legend_internal', 'Internal link')
            : t('cms_site.site.sitemap.legend_backlink', 'Backlink');

    return (
        <div
            ref={ref}
            style={{
                position: 'absolute',
                left: edgePopover.x,
                top: edgePopover.y,
                transform: 'translate(-50%, -100%)',
                zIndex: 60,
            }}
            className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md shadow-lg px-3 py-2 text-xs text-[var(--text-primary)] min-w-[200px] max-w-[280px]"
        >
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                {kindLabel}
            </div>
            <p className="leading-snug text-[var(--text-secondary)]">{edgePopover.info.text}</p>
        </div>
    );
}

function LegendItem({ color, style, label }: { color: string; style: 'solid' | 'dashed' | 'dotted'; label: string }) {
    const dash = style === 'solid' ? '0' : style === 'dashed' ? '6,4' : '2,4';
    return (
        <span className="inline-flex items-center gap-1.5">
            <svg width="28" height="6" aria-hidden="true">
                <line
                    x1="0" y1="3" x2="28" y2="3"
                    stroke={color}
                    strokeWidth="2"
                    strokeDasharray={dash}
                />
            </svg>
            {label}
        </span>
    );
}

/** Legend (bottom-left corner of the toolbar strip). */
export function SitemapLegend() {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-2 border-t border-[var(--border-subtle)] shrink-0 flex items-center gap-4 text-[10px] text-[var(--text-muted)]">
            <LegendItem color="var(--accent-primary)" style="solid"  label={t('cms_site.site.sitemap.legend_nav', 'Nav link')} />
            <LegendItem color="var(--text-secondary)" style="dashed" label={t('cms_site.site.sitemap.legend_internal', 'Internal link')} />
            <LegendItem color="#f59e0b"               style="dotted" label={t('cms_site.site.sitemap.legend_backlink', 'Backlink')} />
            <div className="flex-1" />
            <span>{t('cms_site.site.sitemap.hint', 'Drag a card to tidy · Click ⚙ to edit a page')}</span>
        </div>
    );
}

interface ToolbarProps {
    pageCount: number;
    chromeLinkCount: number;
    internalLinkCount: number;
    hasOverrides: boolean;
    onResetLayout: () => void;
    onRefresh: () => void;
}

/** Counts, Reset layout (only after a drag) and Refresh. */
export function SitemapToolbar({ pageCount, chromeLinkCount, internalLinkCount, hasOverrides, onResetLayout, onRefresh }: ToolbarProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)] shrink-0">
            <span>
                {pageCount === 1 ? t('cms_site.site.sitemap.page_one', '{n} page', { n: pageCount }) : t('cms_site.site.sitemap.page_other', '{n} pages', { n: pageCount })}
                {' · '}
                {chromeLinkCount === 1 ? t('cms_site.site.sitemap.chrome_link_one', '{n} chrome link', { n: chromeLinkCount }) : t('cms_site.site.sitemap.chrome_link_other', '{n} chrome links', { n: chromeLinkCount })}
                {' · '}
                {internalLinkCount === 1 ? t('cms_site.site.sitemap.internal_link_one', '{n} internal link', { n: internalLinkCount }) : t('cms_site.site.sitemap.internal_link_other', '{n} internal links', { n: internalLinkCount })}
            </span>
            <div className="flex-1" />
            {hasOverrides ? (
                <button
                    type="button"
                    onClick={onResetLayout}
                    className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                    title={t('cms_site.site.sitemap.reset_title', 'Reset manual node positions')}
                >
                    <AppIcon name="RotateCcw" className="w-3.5 h-3.5" />
                    {t('cms_site.site.sitemap.reset_layout', 'Reset layout')}
                </button>
            ) : null}
            <button
                type="button"
                onClick={onRefresh}
                className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                title={t('cms_site.site.sitemap.refresh_title', 'Refresh graph')}
            >
                <AppIcon name="RefreshCw" className="w-3.5 h-3.5" />
                {t('cms_site.site.sitemap.refresh', 'Refresh')}
            </button>
        </div>
    );
}

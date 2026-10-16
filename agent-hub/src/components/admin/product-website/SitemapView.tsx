import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppIcon } from './blog/jsComponents';
import { cmsApi } from './cmsApi';
import SettingsFlyout from './sitemap/SettingsFlyout';
import SitemapEdges from './sitemap/SitemapEdges';
import type { EdgePopoverState } from './sitemap/SitemapEdges';
import {
    CHROME_H, CHROME_W, NODE_W, PADDING,
    bfsLayout, collectChromeTargets, collectInternalEdges, ensureOk,
} from './sitemap/sitemapGraph';
import type { SitemapPage, SitemapSite } from './sitemap/sitemapGraph';
import { EdgePopover, NodeCard, SitemapLegend, SitemapToolbar } from './sitemap/SitemapParts';
import useSitemapDrag from './sitemap/useSitemapDrag';
import { useTranslation } from '../../../hooks/useTranslation';
import { authFetch } from '../../../utils/helpers';
import { describeError } from '../../../utils/caughtError';

/**
 * SitemapView — top-down tree of the site's pages.
 *
 *   Site Chrome (pseudo-node, header/footer)
 *           │
 *        Homepage   (rank 0)
 *      ┌────┼────┐
 *      page  page  page          (rank 1 — chrome targets + BFS children)
 *       │
 *       page                     (rank 2 — internal block links)
 *
 *   ── Unlinked pages ──
 *     orphanA   orphanB           (no inbound nav / link)
 *
 * Layout is BFS-based: homepage at rank 0, chrome targets become rank 1
 * children of the homepage, internal block-content links extend the
 * tree to rank 2+. Pages never reached are bucketed at the bottom.
 *
 * Edges are typed:
 *   NAV       — chrome (header / footer)            solid, accent
 *   INTERNAL  — block-content edge that follows the BFS tree
 *               (source IS the target's tree parent) — dashed, muted
 *   BACKLINK  — block-content edge that doesn't follow the tree — dotted, warning
 *
 * Chrome edges are routed through a single "Site Chrome" pseudo-node so
 * the graph doesn't get the N×C inflation the previous version had (one
 * edge per page × chrome target).
 *
 * The component fetches the full admin payload (`cmsApi.site`) so it can
 * derive typed edges client-side — block content isn't on the
 * `/graph` endpoint and we'd otherwise lose the chrome-vs-internal
 * distinction. Graph + layout live in ./sitemap/sitemapGraph.ts.
 */

interface SitemapViewProps {
    siteId: string | null;
    activePageId: string | null;
    onSelectPage?: (pageId: string) => void;
    /** The flyout wrote the site doc directly; the host should reload its copy. */
    onMutated?: () => void;
}

interface AdminPayload {
    site?: SitemapSite | null;
    pages?: Array<{ id: string; blocks?: SitemapPage['blocks'] }>;
}

/** Fetch the admin payload (site + pages with blocks). */
function useSitemapPayload(siteId: string | null) {
    const [adminPayload, setAdminPayload] = useState<AdminPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        if (!siteId) { setLoading(false); setAdminPayload(null); return; }
        setLoading(true);
        setError(null);
        try {
            const res = await authFetch(cmsApi.site(siteId));
            await ensureOk(res, 'Failed to load');
            const data = await res.json();
            setAdminPayload(data);
        } catch (err) {
            setError(describeError(err));
        } finally {
            setLoading(false);
        }
    }, [siteId]);

    useEffect(() => { fetchData(); }, [fetchData]);
    return { adminPayload, loading, error, fetchData };
}

/** Merge the page index (has isHomepage) with the page docs (have blocks), then derive graph + layout. */
function deriveSitemap(adminPayload: AdminPayload | null) {
    if (!adminPayload?.site) return null;
    const site = adminPayload.site;
    const docById = new Map((adminPayload.pages || []).map(p => [p.id, p]));
    const pages: SitemapPage[] = (site.pages || []).map(entry => ({
        ...entry,
        blocks: docById.get(entry.id)?.blocks || [],
    }));
    const { targets: chromeTargets, sources: chromeSources } = collectChromeTargets(site);
    const { edges: internalEdges, meta: internalMeta } = collectInternalEdges(pages);
    const layout = bfsLayout(pages, internalEdges, chromeTargets);
    return { site, pages, chromeTargets, chromeSources, internalEdges, internalMeta, layout };
}

function LoadState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
    const { t } = useTranslation();
    if (!error) {
        return (
            <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)] text-sm">
                {t('cms_site.site.sitemap.loading', 'Loading sitemap…')}
            </div>
        );
    }
    return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm">
            <p className="text-red-400">{error}</p>
            <button type="button" onClick={onRetry} className="px-3 py-1.5 text-xs rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)]">
                {t('cms_site.site.sitemap.retry', 'Retry')}
            </button>
        </div>
    );
}

export default function SitemapView({ siteId, activePageId, onSelectPage, onMutated }: SitemapViewProps) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const { adminPayload, loading, error, fetchData } = useSitemapPayload(siteId);
    const derived = useMemo(() => deriveSitemap(adminPayload), [adminPayload]);
    const drag = useSitemapDrag(containerRef, derived ? derived.layout.positions : null);
    const effectivePositions = drag.positions;

    // UI overlays
    const [flyout, setFlyout]           = useState<{ pageId: string; anchorX: number; anchorY: number } | null>(null);
    const [edgePopover, setEdgePopover] = useState<EdgePopoverState | null>(null);

    // Refresh re-fetches the payload (layout is re-derived above). It
    // deliberately does NOT clear the drag overrides, so manual node tidying
    // survives; Reset layout clears them.
    const handleRefresh = useCallback(() => { fetchData(); }, [fetchData]);

    const openFlyout = useCallback((pageId: string, posX: number, posY: number) => {
        setFlyout({ pageId, anchorX: posX + NODE_W + 12, anchorY: posY });
    }, []);

    if (loading || error) return <LoadState error={loading ? null : error} onRetry={handleRefresh} />;
    if (!derived) return null;

    const { pages, chromeTargets, chromeSources, internalEdges, internalMeta, layout, site } = derived;
    const { parent, chromePos, orphanIds, orphanRowY, canvasWidth, canvasHeight } = layout;
    const flyoutPage = flyout ? pages.find(p => p.id === flyout.pageId) : undefined;

    return (
        <div className="flex-1 flex flex-col min-h-0">
            <SitemapToolbar
                pageCount={pages.length}
                chromeLinkCount={chromeTargets.size}
                internalLinkCount={internalEdges.length}
                hasOverrides={Object.keys(drag.overrides).length > 0}
                onResetLayout={drag.resetLayout}
                onRefresh={handleRefresh}
            />

            {pages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
                    {t('cms_site.site.sitemap.empty', 'No pages yet. Add a page to see the sitemap.')}
                </div>
            ) : (
                <div
                    ref={containerRef}
                    className="flex-1 overflow-auto bg-[var(--bg-secondary)] relative"
                    onMouseMove={drag.handleMouseMove}
                    onMouseUp={drag.handleMouseUp}
                    onMouseLeave={drag.handleMouseUp}
                >
                    <div style={{ width: canvasWidth, height: canvasHeight, position: 'relative' }}>
                        <SitemapEdges
                            canvasWidth={canvasWidth}
                            canvasHeight={canvasHeight}
                            positions={effectivePositions}
                            chromePos={chromePos}
                            chromeTargets={chromeTargets}
                            chromeSources={chromeSources}
                            internalEdges={internalEdges}
                            internalMeta={internalMeta}
                            parent={parent}
                            onEdgeClick={setEdgePopover}
                        />

                        {/* Chrome pseudo-node — pill, not interactive. */}
                        {chromePos ? (
                            <div
                                style={{ position: 'absolute', left: chromePos.x, top: chromePos.y, width: CHROME_W, height: CHROME_H }}
                                className="flex items-center justify-center gap-1.5 px-3 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[10px] uppercase tracking-wider text-[var(--text-secondary)] select-none pointer-events-none"
                                aria-label={t('cms_site.site.sitemap.chrome_aria', 'Site chrome — header and footer')}
                            >
                                <AppIcon name="LayoutTemplate" className="w-3 h-3" />
                                {t('cms_site.site.sitemap.header_footer', 'Header / Footer')}
                            </div>
                        ) : null}

                        {/* Orphan row label, drawn only when there are orphans. */}
                        {orphanIds.size > 0 ? (
                            <div
                                style={{ position: 'absolute', left: PADDING, top: orphanRowY - 28 }}
                                className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] pointer-events-none"
                            >
                                {t('cms_site.site.sitemap.unlinked_pages', 'Unlinked pages')}
                            </div>
                        ) : null}

                        {/* Page nodes (cards). */}
                        {pages.map(page => {
                            const pos = effectivePositions.get(page.id);
                            if (!pos) return null;
                            return (
                                <NodeCard
                                    key={page.id}
                                    page={page}
                                    pos={pos}
                                    isHomepage={!!page.isHomepage}
                                    isOrphan={orphanIds.has(page.id)}
                                    isActive={page.id === activePageId}
                                    inNav={chromeTargets.has(page.id)}
                                    onMouseDown={(e) => drag.handleNodeMouseDown(e, page.id)}
                                    onGear={() => openFlyout(page.id, pos.x, pos.y)}
                                />
                            );
                        })}

                        {edgePopover ? (
                            <EdgePopover edgePopover={edgePopover} onClose={() => setEdgePopover(null)} />
                        ) : null}

                        {flyout && flyoutPage ? (
                            <SettingsFlyout
                                key={flyoutPage.id}
                                page={flyoutPage}
                                pages={pages}
                                site={site}
                                siteId={siteId as string}
                                anchorPos={{ x: flyout.anchorX, y: flyout.anchorY }}
                                canvasWidth={canvasWidth}
                                onClose={() => setFlyout(null)}
                                onOpenInEditor={() => {
                                    // Optional bridge to the page editor — preserves
                                    // the existing onSelectPage API even though
                                    // node clicks no longer fire it.
                                    if (typeof onSelectPage === 'function') onSelectPage(flyoutPage.id);
                                    setFlyout(null);
                                }}
                                // Flyout mutations (title/slug/nav/delete/homepage) write the
                                // site doc directly, bypassing the panel's copy — notify the
                                // host so it can refresh its state and reset undo history
                                // (a stale panel-side save would otherwise clobber the change).
                                onChanged={() => { setFlyout(null); fetchData(); onMutated?.(); }}
                            />
                        ) : null}
                    </div>
                </div>
            )}

            <SitemapLegend />
        </div>
    );
}

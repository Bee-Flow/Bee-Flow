/**
 * The stage: the real page, with the heat on top of it.
 *
 * Coordinate system — the reason this is simpler than it looks. The frame is
 * rendered at exactly the CSS width the clicks were captured at (`width`), so
 * every recorded pageX/pageY is already in the frame's own coordinate space and
 * needs no conversion. Only then is the whole stage scaled down to fit the
 * column, via a CSS transform on the wrapper — the canvas scales with it.
 *
 *   .scroller   overflow, bounded height
 *     .scaler   width*s x height*s          ← reserves the on-screen footprint
 *       .stage  width x height, scale(s)    ← everything inside is 1:1 with the page
 *         iframe / canvas / block outlines / pointer trap
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import HeatCanvas from './HeatCanvas';
import { blockLabel, type ScrollReach } from './model';
import { useTranslation } from '@/hooks/useTranslation';

interface PageStageProps {
    src: string;
    width: number;
    height: number;
    onHighlight?: (value: string | null) => void;
    mode?: string;
    maxHeight?: number;
    frameRef: React.Ref<HTMLIFrameElement>;
    points: Array<{ x: number; y: number; count: number }>;
    blocks?: Array<{ id: string | null; type: string; top: number; height: number }>;
    highlightId?: string | null;
    scroll?: ScrollReach | null;
}

export default function PageStage({
    frameRef, src, width, height, points, blocks,
    highlightId, onHighlight, mode = 'click', scroll = null, maxHeight = 640,
}: PageStageProps) {
    const { t } = useTranslation();
    const scrollerRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);

    // Fit-to-column. Measured rather than assumed: the side panel and the
    // window can both change the available width.
    useLayoutEffect(() => {
        const el = scrollerRef.current;
        if (!el || !width) return undefined;
        const fit = () => {
            const avail = el.clientWidth - 2;
            setScale(avail > 0 ? Math.min(1, avail / width) : 1);
        };
        fit();
        if (typeof ResizeObserver !== 'function') return undefined;
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        return () => ro.disconnect();
    }, [width]);

    // The frame is mounted before the page has been measured, so it needs a
    // height to occupy in the meantime — otherwise the scroller collapses and
    // the iframe has nothing to render into.
    const h = height || 640;

    return (
        <div
            ref={scrollerRef}
            // The page behind the heat is the customer's own page: it renders on
            // white whatever the admin theme, exactly as a visitor saw it.
            className="relative overflow-auto rounded-xl border border-[var(--border-default)] bg-white"
            style={{ maxHeight }}
        >
            <div className="relative" style={{ width: width * scale, height: h * scale }}>
                <div className="relative origin-top-left" style={{ width, height: h || undefined, transform: `scale(${scale})` }}>
                    <iframe
                        ref={frameRef}
                        src={src}
                        title={t('cms_site.analytics.page_stage.frame_title', 'Page being analysed')}
                        // The frame renders its full height and never scrolls;
                        // the outer scroller does. That keeps document-Y and
                        // on-screen-Y the same number, which is what lets a
                        // recorded pageY land where it was actually clicked.
                        scrolling="no"
                        className="block border-0 bg-white"
                        style={{ width, height: h }}
                    />

                    {mode === 'click' && (
                        <HeatCanvas points={points} width={width} height={h} />
                    )}

                    {mode === 'scroll' && (scroll?.steps?.length as number) > 0 && (
                        <ScrollShade steps={(scroll as ScrollReach).steps} height={h} width={width} viewportH={(scroll as ScrollReach).viewportH as number} />
                    )}

                    {/* Block outlines: hover-linked to the ranking table. */}
                    {blocks?.map(b => (
                        <div
                            key={b.id}
                            aria-hidden="true"
                            className={`pointer-events-none absolute inset-x-0 transition-colors ${highlightId === b.id ? 'bg-[color-mix(in_srgb,var(--chart-1)_10%,transparent)] outline-2 -outline-offset-2 outline-[var(--chart-1)]' : ''}`}
                            style={{ top: b.top, height: b.height }}
                        />
                    ))}

                    {/*
                      Pointer trap. Everything below the frame is inert: no link
                      navigation, no hover chrome, no focus stealing. It also
                      gives us hover-to-highlight without touching the frame.
                    */}
                    <div
                        onMouseLeave={() => onHighlight?.(null)}
                        onMouseMove={(e) => {
                            if (!onHighlight || !blocks?.length) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const y = (e.clientY - rect.top) / scale;
                            let hit = null;
                            for (const b of blocks) if (y >= b.top && y < b.top + b.height) hit = b;
                            onHighlight(hit?.id || null);
                        }}
                        className="absolute inset-0 [cursor:crosshair]"
                    />
                </div>
            </div>
        </div>
    );
}

/**
 * Scroll reach as progressive dimming: the further down the page, the fewer
 * people saw it, the darker it gets. The fold line marks the first screen.
 */
interface ScrollShadeProps {
    height: number;
    width: number;
    steps: ScrollReach['steps'];
    viewportH: number;
}

function ScrollShade({ steps, height, width, viewportH }: ScrollShadeProps) {
    const { t } = useTranslation();
    const bands = [];
    for (let i = 0; i < steps.length; i++) {
        const from = (steps[i].depth / 100) * height;
        const to = i + 1 < steps.length ? (steps[i + 1].depth / 100) * height : height;
        if (to <= from) continue;
        bands.push({
            top: from, height: to - from,
            // 100% reach → no shade; 0% → nearly black.
            alpha: Math.max(0, Math.min(0.78, (1 - steps[i].reach / 100) * 0.82)),
            reach: steps[i].reach,
        });
    }
    return (
        <>
            {bands.map((b, i) => (
                // The shade is the data: darker where fewer visitors scrolled.
                <div key={i} aria-hidden="true" className="absolute left-0 bg-black" style={{ width, top: b.top, height: b.height, opacity: b.alpha }} />
            ))}
            {viewportH > 0 && viewportH < height && (
                <div className="pointer-events-none absolute left-0" style={{ width, top: viewportH }}>
                    <div className="border-t-2 border-dashed border-[var(--chart-1)]" />
                    <span className="ml-2 mt-1 inline-block rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-primary)] shadow-[var(--shadow-sm)]">
                        {t('cms_site.analytics.page_stage.fold', 'The fold — everything below this needs a scroll')}
                    </span>
                </div>
            )}
        </>
    );
}

;

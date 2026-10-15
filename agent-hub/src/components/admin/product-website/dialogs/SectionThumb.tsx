import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ComponentType } from 'react';
import { SECTION_REGISTRY } from '../../../../marketing/ProductWebsite';
import BlockThumb from '../blockEditors/blockThumbs';
import { demoContentFor, WIREFRAME_ONLY } from './thumbDemoContent';

// The marketing renderer's section components, keyed by block type.
const SECTIONS: Record<string, unknown> = SECTION_REGISTRY;

/**
 * SectionThumb — a live, scaled-down render of the REAL section component
 * for the AddBlockDialog gallery (WS3-P4). The tile shows the actual
 * marketing renderer at scale ≈0.2 with curated demo content, so the
 * gallery previews what the section truly looks like — in the site's own
 * palette when `design` is passed.
 *
 * Safety rails:
 *   - marketing.css is already loaded in the admin document (App.jsx
 *     imports marketing/ProductWebsite statically) and is fully
 *     `.marketing-root`-scoped; its four @keyframes names collide with
 *     nothing in the admin CSS (verified). Thumbs additionally kill all
 *     animations/reveals inside `.cms-section-thumb` so nothing is stuck
 *     at opacity 0 and 15 tiles cost no animation frames.
 *   - A render error in any section falls back to the legacy SVG
 *     wireframe (ThumbErrorBoundary) instead of breaking the dialog.
 *   - 'live-component' (runs user code) and 'pricing' (network fetch)
 *     never live-render — they keep the wireframe (WIREFRAME_ONLY).
 *   - Tiles lazy-mount via IntersectionObserver so opening the dialog
 *     doesn't mount 15 full sections at once. Environments without IO
 *     (jsdom) mount immediately.
 */

const LOGICAL_WIDTH = 1100;              // unscaled render width (px)
const ASPECT = [220, 130];               // tile viewport aspect ratio
const LOGICAL_HEIGHT = Math.round(LOGICAL_WIDTH * (ASPECT[1] / ASPECT[0])); // 650

// ── One-time thumb CSS ──────────────────────────────────────────────
// Scoped under .cms-section-thumb; forces reveal/entrance elements
// visible (they normally wait for the root IntersectionObserver that
// only runs in the real renderer) and freezes every animation.
const THUMB_STYLE_ID = 'cms-section-thumb-styles';
const THUMB_CSS = `
.cms-section-thumb {
    position: relative;
    width: 100%;
    aspect-ratio: ${ASPECT[0]} / ${ASPECT[1]};
    overflow: hidden;
    background: var(--bg-tertiary);
}
.cms-section-thumb > .marketing-root {
    position: absolute;
    top: 0;
    left: 0;
    width: ${LOGICAL_WIDTH}px;
    min-height: ${LOGICAL_HEIGHT}px;
    transform-origin: top left;
    pointer-events: none;
}
.cms-section-thumb .marketing-root .reveal {
    opacity: 1 !important;
    transform: none !important;
    transition: none !important;
}
.cms-section-thumb .marketing-root * {
    animation: none !important;
}
`;

function ensureThumbStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(THUMB_STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = THUMB_STYLE_ID;
    el.textContent = THUMB_CSS;
    document.head.appendChild(el);
}

// Mirror of the color/radius subset of applyDesignToRoot
// (marketing/ProductWebsite.jsx) — inline CSS vars on the thumb's
// .marketing-root so the gallery previews YOUR palette. Fonts/typography
// are deliberately skipped (static default type is fine at 20% scale and
// avoids font-loading work in the admin document).
export interface ThumbDesign {
    colors?: {
        primary?: string;
        secondary?: string;
        accent?: string;
        background?: string;
        surface?: string;
        textPrimary?: string;
        textSecondary?: string;
    };
    radius?: number;
}

function designVars(design: ThumbDesign | null | undefined): Record<string, string> | null {
    if (!design || typeof design !== 'object') return null;
    const c = design.colors || {};
    const vars: Record<string, string> = {};
    if (c.primary)       vars['--brand-primary']        = c.primary;
    if (c.secondary)     vars['--brand-secondary']      = c.secondary;
    if (c.accent)        vars['--brand-accent']         = c.accent;
    if (c.background)    vars['--brand-bg']             = c.background;
    if (c.surface)       vars['--brand-surface']        = c.surface;
    if (c.textPrimary)   vars['--brand-text']           = c.textPrimary;
    if (c.textSecondary) vars['--brand-text-secondary'] = c.textSecondary;
    if (typeof design.radius === 'number' && design.radius >= 0 && design.radius <= 48) {
        vars['--radius-base'] = `${design.radius}px`;
    }
    return Object.keys(vars).length ? vars : null;
}

// Absolute-fill wireframe (error fallback + WIREFRAME_ONLY types) —
// the old SVG schematic, centered in the same viewport box.
function WireframeFill({ type }: { type: string }) {
    return (
        <div className="absolute inset-0 flex items-center justify-center px-2">
            <BlockThumb type={type} />
        </div>
    );
}

interface ThumbErrorBoundaryProps {
    fallback: ReactNode;
    children?: ReactNode;
}

class ThumbErrorBoundary extends React.Component<ThumbErrorBoundaryProps, { hasError: boolean }> {
    constructor(props: ThumbErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(): { hasError: boolean } {
        return { hasError: true };
    }

    componentDidCatch(error: Error) {
        if (import.meta.env?.DEV) {
            console.warn('[SectionThumb] live render failed, using wireframe:', error?.message);
        }
    }

    render() {
        if (this.state.hasError) return this.props.fallback;
        return this.props.children;
    }
}

export interface SectionThumbProps {
    type: string;
    variant?: string | null;
    design?: ThumbDesign | null;
}

export default function SectionThumb({ type, variant = null, design = null }: SectionThumbProps) {
    ensureThumbStyles();
    const boxRef = useRef<HTMLDivElement>(null);
    const wireframeOnly = WIREFRAME_ONLY.has(type) || !SECTIONS[type];

    // Lazy mount — placeholder until the tile scrolls into view.
    const [visible, setVisible] = useState(
        () => typeof IntersectionObserver === 'undefined');
    useEffect(() => {
        if (visible || wireframeOnly) return undefined;
        const el = boxRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return undefined;
        const io = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) {
                setVisible(true);
                io.disconnect();
            }
        }, { rootMargin: '120px' });
        io.observe(el);
        return () => io.disconnect();
    }, [visible, wireframeOnly]);

    // Fit the 1100px logical render to the actual tile width.
    const [scale, setScale] = useState(ASPECT[0] / LOGICAL_WIDTH);
    useLayoutEffect(() => {
        if (wireframeOnly) return undefined;
        const el = boxRef.current;
        if (!el) return undefined;
        const measure = () => {
            const w = el.clientWidth;
            if (w > 0) setScale(w / LOGICAL_WIDTH);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [wireframeOnly]);

    const Comp = SECTIONS[type] as ComponentType<{ data: Record<string, unknown> }>;
    const vars = designVars(design);

    return (
        <div ref={boxRef} className="cms-section-thumb" aria-hidden="true">
            {wireframeOnly ? (
                <WireframeFill type={type} />
            ) : visible ? (
                <ThumbErrorBoundary fallback={<WireframeFill type={type} />}>
                    <div
                        className="marketing-root"
                        style={{ ...(vars || {}), transform: `scale(${scale})` }}
                    >
                        <Comp data={{ enabled: true, ...demoContentFor(type, variant) }} />
                    </div>
                </ThumbErrorBoundary>
            ) : null}
        </div>
    );
}

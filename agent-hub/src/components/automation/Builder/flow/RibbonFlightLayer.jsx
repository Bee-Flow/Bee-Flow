import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import IntegrationLogo from './nodes/IntegrationLogo';
import { CARD_W, typeTileStyle } from './nodeTypeColors';
import { StepIcon } from './stepIcons';
import { FLY_MS } from './useRibbonFlight';

/**
 * The ghost that flies from the ribbon to the canvas (useRibbonFlight.js
 * decides when; ribbonOrigin.js from where and looking like what).
 *
 * One fixed, pointer-transparent layer over the whole page, portalled to
 * <body>: the ribbon and the canvas are in different stacking contexts, and
 * React Flow's viewport clips its children, so a ghost drawn inside either
 * could not cross from one to the other. Each ghost is a plain <div> shell of
 * a card (240×72, the card's own chrome tokens) that this component moves by
 * writing `style.transform` from a requestAnimationFrame loop — NEVER a React
 * Flow node, whose wrapper is positioned by React Flow's own inline
 * translate() (index.css.motion.test.js forbids touching that).
 *
 * The destination is re-read EVERY frame through `rf.flowToScreenPosition`.
 * The camera is usually moving while a ghost is in the air (the push-in is
 * cued at the same departure), and a destination sampled once at take-off
 * would land the ghost where the slot WAS. Under the test's fake timers rAF
 * is faked too, so `advanceTimersByTime` drives the frames.
 */

/** The ghost card's height: a card at rest (nodeTypeColors CARD_H is the same 72). */
const CARD_H = 72;
/** A ghost never flies smaller than this share of a card, or the tile it leaves from reads as a dot. */
const MIN_START_SCALE = 0.08;
/** Ease-out cubic: fast off the ribbon, settling onto the slot. */
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/**
 * A node's absolute flow position: React Flow's own (a node inside an
 * expanded flowlet is stored parent-relative; `internals.positionAbsolute`
 * has the parents added back), else the layout's, walking parentId.
 */
function absolutePositionOf(id, rf, nodes) {
    const rfNode = rf?.getNode?.(id);
    const abs = rfNode?.internals?.positionAbsolute;
    if (abs && Number.isFinite(abs.x) && Number.isFinite(abs.y)) return { x: abs.x, y: abs.y };
    const byId = new Map();
    for (const n of Array.isArray(nodes) ? nodes : []) if (n?.id != null) byId.set(n.id, n);
    const node = byId.get(id);
    if (!node?.position) return null;
    let { x, y } = node.position;
    let parent = node.parentId;
    for (let hops = 0; parent && hops < 16; hops += 1) {
        const p = byId.get(parent);
        if (!p?.position) break;
        x += p.position.x;
        y += p.position.y;
        parent = p.parentId;
    }
    return { x, y };
}

/** Where the card's top-left is on screen right now, or null when nothing can say. */
function destinationOf(id, rf, nodes) {
    if (typeof rf?.flowToScreenPosition !== 'function') return null;
    const pos = absolutePositionOf(id, rf, nodes);
    if (!pos) return null;
    try {
        const p = rf.flowToScreenPosition(pos);
        return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
    } catch {
        return null;
    }
}

function Ghost({ ghost, rf, nodes }) {
    const ref = useRef(null);
    // The same tile the card will wear: family tint, and the family's shape
    // (a form page's circle, a branch's diamond) read off the step type.
    const { tile: tileStyle, glyph: glyphStyle } = typeTileStyle(ghost.glyph?.family || null, { type: ghost.glyph?.type || null });

    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        let raf = 0;
        let landed = false;
        const from = ghost.from || { left: 0, top: 0, width: 28, height: 28 };
        const startScale = Math.max(MIN_START_SCALE, (Number(from.width) || 28) / CARD_W);
        const frame = () => {
            const t = Math.min(1, Math.max(0, (Date.now() - ghost.startedAt) / FLY_MS));
            const p = easeOutCubic(t);
            const dest = destinationOf(ghost.id, rf, nodes);
            const zoom = Math.min(1, Number(rf?.getZoom?.()) || 1);
            const tx = dest ? from.left + (dest.x - from.left) * p : from.left;
            const ty = dest ? from.top + (dest.y - from.top) * p : from.top;
            const s = startScale + (zoom - startScale) * p;
            el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
            if (t >= 1) {
                if (!landed) {
                    landed = true;
                    el.classList.add('bf-fly-ghost-land');
                }
                return;
            }
            raf = requestAnimationFrame(frame);
        };
        frame();
        return () => { if (raf) cancelAnimationFrame(raf); };
    }, [ghost, rf, nodes]);

    const glyph = ghost.glyph || {};
    const Icon = glyph.icon;
    const fallback = Icon ? <Icon size={16} /> : null;
    return (
        <div
            ref={ref}
            data-testid="ribbon-flight-ghost"
            data-step-id={ghost.id}
            aria-hidden="true"
            style={{
                position: 'fixed',
                left: 0,
                top: 0,
                width: CARD_W,
                height: CARD_H,
                transformOrigin: '0 0',
                willChange: 'transform',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 12px',
                borderRadius: 12,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-popover)',
                color: 'var(--text-primary)',
            }}
        >
            <span style={tileStyle}>
                <span style={glyphStyle}>
                    {glyph.integrationId || glyph.tool
                        ? <IntegrationLogo integrationId={glyph.integrationId} tool={glyph.tool} size={16} fallback={fallback} />
                        : <StepIcon name={glyph.iconName} size={16} fallback={fallback} />}
                </span>
            </span>
            <span className="min-w-0 truncate text-[13px] font-medium" style={{ lineHeight: '17px' }}>{glyph.label || ''}</span>
        </div>
    );
}

export default function RibbonFlightLayer({ ghosts, rf, nodes = null }) {
    const list = Array.isArray(ghosts) ? ghosts : [];
    if (!list.length || typeof document === 'undefined') return null;
    return createPortal(
        <div
            data-testid="ribbon-flight-layer"
            style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1100 }}
        >
            {list.map(g => <Ghost key={g.id} ghost={g} rf={rf} nodes={nodes} />)}
        </div>,
        document.body,
    );
}

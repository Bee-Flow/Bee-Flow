import { Brain } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { TIER_META, customTierMeta, configuredTierKeys, tierCatalogId, DEPTH_TIER_KEYS } from './tierMeta';
import scopedStorage from '../../utils/scopedStorage';
import AppEmoji from '../icons/AppEmoji';

/**
 * Composer tier control — a slider, not a menu.
 *
 * WHY A SLIDER. The tiers a chat composer offers are, in practice, one model at
 * increasing depth: on a default install `fast`, `thinking` and `pro` all point
 * at the same model and differ only in their configured `reasoningEffort`
 * (low / medium / xhigh). A vertical menu of four items hides that ordering;
 * a slider states it. The tier's own effort travels with it server-side, so
 * this one control replaces the old tier menu AND the separate thinking-effort
 * dropdown that sat beside it.
 *
 * WHAT IS NOT ON THE SLIDER. Flow, Swarm, Write and custom tiers are kinds of
 * work rather than depths (see DEPTH_TIER_KEYS in tierMeta.js). They render as
 * pills underneath, and only when the server actually has them configured — on
 * most installs that row is empty and the panel is just the slider.
 *
 * The dropdown (`ModelTierSelector`) is still the right control for the
 * settings forms that pick a tier for an agent, an automation step or an App
 * Studio action; both read the same tierMeta so the two can never disagree
 * about labels, icons or which tiers are configured.
 */

// Legacy per-message effort override, written by the thinking-effort dropdown
// this control replaces. `useChatEngine` still reads it at send time and, when
// present, it wins over the tier's own effort — so a value left behind by the
// old dropdown would silently pin Deep Thinking to "Low" forever. Clear it once.
const LEGACY_EFFORT_KEY = 'reasoningEffort';

/** Icon for a tier, in the same precedence the dropdown uses. */
function TierIcon({ tierKey, meta, className = 'w-3.5 h-3.5', style }) {
    if (meta.iconSrc) return <img src={meta.iconSrc} alt="" className={`${className} object-contain`} />;
    if (meta.Icon) return <meta.Icon className={className} style={style} />;
    return <AppEmoji id={tierCatalogId(tierKey)} default={meta.emoji} />;
}

// ── Gauge ────────────────────────────────────────────────────────────────
// A speedometer, drawn from the same index the slider uses, so the collapsed
// trigger already tells you how deep the next answer will go. A per-tier glyph
// (bolt / brain / bulb) can't do that: it names the tier but says nothing about
// where the tier sits on the scale.
//
// 270° of arc with the gap at the bottom — the conventional gauge reading, and
// the shape leaves room for the needle to swing without clipping.
const GAUGE_START_DEG = -135;
const GAUGE_SWEEP_DEG = 270;

/** Degrees are clockwise from 12 o'clock, which is how a gauge is read. */
function polarPoint(cx, cy, r, deg) {
    const rad = (deg - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, fromDeg, toDeg) {
    const start = polarPoint(cx, cy, r, fromDeg);
    const end = polarPoint(cx, cy, r, toDeg);
    const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

// The needle sweeps rather than jumps — a gauge that teleports reads as a state
// change, one that swings reads as a measurement. Slight overshoot on the
// needle (the `1.5` in the curve) is what makes it feel like a physical dial;
// the arc uses a plain ease-out because a fill that bounces looks broken.
const GAUGE_SWEEP_MS = 520;
const NEEDLE_EASING = `transform ${GAUGE_SWEEP_MS}ms cubic-bezier(0.34, 1.5, 0.64, 1)`;
const ARC_EASING = `stroke-dashoffset ${GAUGE_SWEEP_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;

const GAUGE_RADIUS = 8.5;
// Length of the 270° arc, so the fill can be animated with stroke-dashoffset.
// `d` is not a transitionable property, so redrawing the path each time — the
// first attempt — could never animate no matter what duration it was given.
const GAUGE_ARC_LEN = (GAUGE_SWEEP_DEG / 360) * 2 * Math.PI * GAUGE_RADIUS;

/**
 * @param {number|null} fraction 0–1 along the depth scale, or null when the
 *   current tier isn't on it (Flow/Swarm/Write) — the needle then rests at the
 *   start and the arc stays unfilled rather than implying a depth it hasn't got.
 * @param {boolean} auto Auto is NOT a position on the dial. It sits at the left
 *   of the track, but it means "pick for me" and the router may well land on
 *   Deep Thinking — a needle pinned to the minimum states the opposite, and a
 *   needle parked mid-sweep just invents a depth. So Auto drops the needle
 *   entirely: the whole arc lights (dimmed — the range is available, not maxed)
 *   and an "A" takes the pivot's place.
 */
function TierGauge({ fraction, auto = false, size = 17 }) {
    const c = 12;
    const f = typeof fraction === 'number' ? Math.min(1, Math.max(0, fraction)) : null;
    const inactive = f === null && !auto;
    const needleDeg = GAUGE_START_DEG + GAUGE_SWEEP_DEG * (f ?? 0);
    const filled = auto ? 1 : (f ?? 0);
    const trackPath = arcPath(c, c, GAUGE_RADIUS, GAUGE_START_DEG, GAUGE_START_DEG + GAUGE_SWEEP_DEG);

    return (
        <svg
            width={size} height={size} viewBox="0 0 24 24" fill="none"
            aria-hidden="true" data-testid="tier-gauge" data-mode={auto ? 'auto' : inactive ? 'off' : 'fixed'}
            style={{ flexShrink: 0, display: 'block' }}
        >
            <path d={trackPath} stroke="currentColor" strokeOpacity="0.28" strokeWidth="2.4" strokeLinecap="round" />
            <path
                d={trackPath}
                stroke="var(--accent-primary)" strokeWidth="2.4" strokeLinecap="round"
                strokeDasharray={GAUGE_ARC_LEN}
                strokeDashoffset={GAUGE_ARC_LEN * (1 - filled)}
                style={{
                    transition: ARC_EASING,
                    // Auto's full sweep is dimmed: the range is available, not
                    // maxed out. A solid full arc would read as "Deep Thinking".
                    opacity: inactive ? 0 : auto ? 0.45 : 1,
                }}
            />
            {auto ? (
                <text
                    data-testid="tier-gauge-auto"
                    x={c} y={c}
                    textAnchor="middle" dominantBaseline="central"
                    fill="var(--accent-primary)"
                    style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '-0.02em' }}
                >
                    A
                </text>
            ) : (
                <>
                    {/* Drawn pointing straight up, then rotated: rotation is
                        transitionable where a recomputed end point is not. */}
                    <g
                        data-testid="tier-gauge-needle"
                        style={{
                            transform: `rotate(${needleDeg}deg)`,
                            transformOrigin: `${c}px ${c}px`,
                            transformBox: 'view-box',
                            transition: NEEDLE_EASING,
                        }}
                    >
                        <line
                            x1={c} y1={c} x2={c} y2={c - (GAUGE_RADIUS - 2.4)}
                            stroke={inactive ? 'currentColor' : 'var(--accent-primary)'}
                            strokeOpacity={inactive ? 0.4 : 1}
                            strokeWidth="2" strokeLinecap="round"
                        />
                    </g>
                    <circle cx={c} cy={c} r="1.7" fill={inactive ? 'currentColor' : 'var(--accent-primary)'} fillOpacity={inactive ? 0.4 : 1} />
                </>
            )}
        </svg>
    );
}

// Track geometry. THUMB_PAD is the inset every stop centre must respect so the
// 28px thumb never clips the 40px track: 6px of breathing room + its own 14px
// radius. Dots AND labels are positioned off the SAME expression, which is what
// keeps them in one vertical line — the first attempt used flex `space-between`
// for the dots and `flex: 1` cells for the labels, and the two disagreed as
// soon as the active dot grew from 10px to 28px and reflowed the row.
const THUMB_PAD = 20;
const THUMB_RADIUS = 14;

/** Horizontal centre of stop `i`, as a CSS length usable by both rows. */
const stopCenter = (i, count) => (count < 2
    ? '50%'
    : `calc(${THUMB_PAD}px + (100% - ${THUMB_PAD * 2}px) * ${i / (count - 1)})`);

// Depth reads as INTENSITY, not only as bar length, and the ramp is visible
// within a single view: the fill is a gradient that starts soft at the shallow
// end and deepens toward the thumb. Its dark end also tracks travel, so Deep
// Thinking's right edge is the deepest ink while Fast's only reaches mid — you
// see the gradient in one screen AND the difference between the levels.
//
// The ramp is mixed from the theme's own INK (`--text-primary`) into its own
// track surface (`--bg-tertiary`), never from `--accent-primary`. The accent
// is a free-form colour an admin picks in Appearance and it defaults to a cool
// grey (`#9ca3af`), which painted a grey bar across the warm Paper/Sepia
// presets — foreign to every surface around it. Ink-over-surface is warm on a
// warm theme and cool on a cool one by construction, so the bar belongs to
// whatever preset is selected.
const FILL_START_PCT = 10;   // % ink at the very left of the bar
const FILL_MIN_END_PCT = 20; // % ink at the thumb when barely moved
const FILL_MAX_END_PCT = 44; // % ink at the thumb at the deepest level
// …which puts the four stops at 20 / 28 / 36 / 44% ink at the thumb — far
// enough apart to tell the levels apart at a glance without the shallow end
// disappearing into the track.
const inkMix = (pct) => `color-mix(in srgb, var(--text-primary) ${pct}%, var(--bg-tertiary))`;
const fillGradientFor = (travel) => {
    const end = Math.round(FILL_MIN_END_PCT + (FILL_MAX_END_PCT - FILL_MIN_END_PCT) * travel);
    return `linear-gradient(90deg, ${inkMix(FILL_START_PCT)} 0%, ${inkMix(end)} 100%)`;
};

/**
 * The track itself: a filled bar, one dot per stop, and the labels under it.
 * `activeIndex` is -1 when the selected tier isn't on the depth scale, which
 * dims the whole track rather than parking the thumb somewhere misleading.
 */
function TierTrack({ stops, activeIndex, metaFor, onSelect, trackRef, onPointerDown, onPointerMove, onPointerEnd, onKeyDown }) {
    const onScale = activeIndex >= 0;
    const count = stops.length;
    // How far along the track the thumb has travelled, 0–1.
    const travel = onScale && count > 1 ? activeIndex / (count - 1) : 0;

    return (
        <>
            <div
                ref={trackRef}
                role="slider"
                tabIndex={0}
                aria-label="Response depth"
                aria-valuemin={0}
                aria-valuemax={Math.max(0, count - 1)}
                aria-valuenow={Math.max(0, activeIndex)}
                aria-valuetext={onScale ? metaFor(stops[activeIndex]).label : 'Not on the depth scale'}
                onKeyDown={onKeyDown}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                data-testid="tier-slider-track"
                style={{
                    position: 'relative', height: '40px', borderRadius: '9999px',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-tertiary)',
                    cursor: 'pointer', touchAction: 'none',
                    opacity: onScale ? 1 : 0.45,
                }}
            >
                {/* Fill runs from the left inset to the far edge of the thumb,
                    so its rounded cap sits under the thumb instead of poking
                    out past it. Colour tracks travel — see fillColorFor. */}
                <div
                    data-testid="tier-slider-fill"
                    aria-hidden="true"
                    style={{
                        position: 'absolute', left: '5px', top: '5px', bottom: '5px',
                        width: onScale
                            ? `calc(${stopCenter(activeIndex, count)} + ${THUMB_RADIUS - 5}px)`
                            : '0px',
                        borderRadius: '9999px',
                        background: fillGradientFor(travel),
                        opacity: onScale ? 1 : 0,
                        transition: 'width 0.18s ease, background 0.28s ease',
                    }}
                />
                {stops.map((key, i) => {
                    const isActive = i === activeIndex;
                    const isPassed = onScale && i < activeIndex;
                    const meta = metaFor(key);
                    const dot = isActive ? 28 : 10;
                    return (
                        <button
                            key={key}
                            type="button"
                            tabIndex={-1}
                            onClick={(e) => { e.stopPropagation(); onSelect(key); }}
                            title={`${meta.label} — ${meta.desc || ''}`.trim()}
                            aria-label={meta.label}
                            data-testid={`tier-slider-stop-${key}`}
                            style={{
                                position: 'absolute',
                                left: stopCenter(i, count),
                                top: '50%',
                                // Centres the dot on its stop whatever its size,
                                // so growing the active one moves nothing else.
                                transform: 'translate(-50%, -50%)',
                                width: `${dot}px`, height: `${dot}px`,
                                borderRadius: '9999px', border: 'none', padding: 0, cursor: 'pointer',
                                background: isActive ? '#fff' : isPassed ? 'rgba(255,255,255,0.6)' : 'var(--text-tertiary)',
                                opacity: isActive || isPassed ? 1 : 0.45,
                                boxShadow: isActive ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
                                transition: 'width 0.18s ease, height 0.18s ease, background 0.18s ease',
                            }}
                        />
                    );
                })}
            </div>

            {/* Same `stopCenter` expression as the dots. The outer two are
                nudged inward so a wide label ("Deep Thinking") stays inside the
                panel instead of centring itself off the edge. */}
            <div data-testid="tier-slider-labels" style={{ position: 'relative', height: '16px', marginTop: '8px' }}>
                {stops.map((key, i) => (
                    <span
                        key={key}
                        style={{
                            position: 'absolute',
                            left: stopCenter(i, count),
                            transform: `translateX(${i === 0 ? '-30%' : i === count - 1 ? '-70%' : '-50%'})`,
                            whiteSpace: 'nowrap',
                            fontSize: '10px', lineHeight: '16px',
                            color: i === activeIndex ? 'var(--text-primary)' : 'var(--text-tertiary)',
                            fontWeight: i === activeIndex ? 600 : 400,
                        }}
                    >
                        {metaFor(key).label}
                    </span>
                ))}
            </div>
        </>
    );
}

/** Kinds of work that don't sit on the depth scale — Flow, Swarm, Write, custom. */
function OtherTierPills({ keys, value, metaFor, onSelect }) {
    return (
        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {keys.map(key => {
                    const meta = metaFor(key);
                    const selected = key === value;
                    return (
                        <button
                            key={key}
                            type="button"
                            onClick={() => onSelect(key)}
                            aria-pressed={selected}
                            title={meta.desc || meta.label}
                            data-testid={`tier-slider-other-${key}`}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: '6px',
                                padding: '5px 10px', borderRadius: '9999px',
                                fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                                color: selected ? '#fff' : 'var(--text-primary)',
                                background: selected ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                border: '1px solid var(--border-subtle)',
                            }}
                        >
                            <TierIcon tierKey={key} meta={meta} className="w-3 h-3" />
                            <span>{meta.label}</span>
                            {meta.beta && (
                                <span style={{
                                    fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.04em',
                                    padding: '1px 5px', borderRadius: '9999px',
                                    background: selected ? 'rgba(255,255,255,0.25)' : 'var(--bg-secondary)',
                                    color: selected ? '#fff' : 'var(--text-tertiary)',
                                }}>
                                    beta
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * Memory switch, parked in the panel's top-right corner.
 *
 * It lives here rather than in the composer's icon row because both settings
 * answer the same question — how much the assistant brings to the next turn —
 * and the row was getting long. Icon-only and unlabelled to stay quiet next to
 * the tier name; the state is carried by colour, `title` and `aria-pressed`.
 */
function MemoryToggle({ enabled, onToggle }) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={enabled}
            aria-label={enabled ? 'Memory saving enabled' : 'Memory saving paused'}
            title={enabled ? 'Memory saving enabled — click to pause' : 'Memory saving paused — click to resume'}
            data-testid="tier-slider-memory-toggle"
            style={{
                position: 'absolute', top: '10px', right: '10px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: '28px', height: '28px', borderRadius: '9999px',
                border: 'none', padding: 0, cursor: 'pointer',
                background: enabled ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : 'transparent',
                color: enabled ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                opacity: enabled ? 1 : 0.55,
                transition: 'background 0.15s, color 0.15s, opacity 0.15s',
            }}
        >
            <Brain className="w-4 h-4" />
        </button>
    );
}

export default function TierSlider({ tiers = {}, value = 'fast', onChange, variant = 'input', memory = null }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const trackRef = useRef(null);
    const panelRef = useRef(null);
    const draggingRef = useRef(false);
    // Correction applied on top of the centring transform. Measured once per
    // open, from the centred position, so it converges immediately.
    const [edgeNudge, setEdgeNudge] = useState(0);

    useEffect(() => { scopedStorage.removeItem(LEGACY_EFFORT_KEY); }, []);

    useLayoutEffect(() => {
        if (!open) { setEdgeNudge(0); return; }
        const el = panelRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const margin = 8;
        if (r.left < margin) setEdgeNudge(margin - r.left);
        else if (r.right > window.innerWidth - margin) setEdgeNudge((window.innerWidth - margin) - r.right);
    }, [open]);

    useEffect(() => {
        const handler = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const metaFor = useCallback((key) => (
        TIER_META[key]
        || (key?.startsWith('custom:') ? customTierMeta(key, tiers[key]) : null)
        || TIER_META.fast
    ), [tiers]);

    // configuredTierKeys already applies the canonical order and drops tiers
    // with no model configured, so the split below preserves both.
    const { stops, others } = useMemo(() => {
        const keys = configuredTierKeys(tiers);
        return {
            stops: keys.filter(k => DEPTH_TIER_KEYS.includes(k)),
            others: keys.filter(k => !DEPTH_TIER_KEYS.includes(k)),
        };
    }, [tiers]);

    const activeIndex = stops.indexOf(value);
    const currentMeta = metaFor(value);
    const isAuto = value === 'auto';

    // The gauge maps the REAL depths only — Auto is a choice on the track but
    // not a depth, and including it would push Fast a third of the way up the
    // dial and leave Auto and Fast looking almost identical. Excluding it puts
    // Fast at the floor and Deep Thinking at the ceiling, which is what the
    // needle should say. null = a tier off the scale entirely (Flow/Swarm).
    const scaleStops = useMemo(() => stops.filter(k => k !== 'auto'), [stops]);
    const scaleIndex = scaleStops.indexOf(value);
    const depthFraction = scaleIndex < 0
        ? null
        : (scaleStops.length > 1 ? scaleIndex / (scaleStops.length - 1) : 1);

    const commit = useCallback((next) => {
        if (next && next !== value) onChange?.(next);
    }, [onChange, value]);

    const selectIndex = useCallback((i) => {
        if (!stops.length) return;
        commit(stops[Math.min(stops.length - 1, Math.max(0, i))]);
    }, [stops, commit]);

    // Measured against the same inset the dots are laid out on, or a click on
    // the far left would land between "before the first stop" and the first
    // stop's centre and read as a fractional position.
    const indexFromClientX = useCallback((clientX) => {
        const el = trackRef.current;
        if (!el || stops.length < 2) return 0;
        const r = el.getBoundingClientRect();
        const usable = Math.max(1, r.width - THUMB_PAD * 2);
        const ratio = Math.min(1, Math.max(0, (clientX - r.left - THUMB_PAD) / usable));
        return Math.round(ratio * (stops.length - 1));
    }, [stops.length]);

    const handlePointerDown = (e) => {
        if (!stops.length) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        selectIndex(indexFromClientX(e.clientX));
    };
    const handlePointerMove = (e) => {
        if (draggingRef.current) selectIndex(indexFromClientX(e.clientX));
    };
    const handlePointerEnd = (e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
    };

    // APG slider keys. Home/End matter more here than usual: "cheapest" and
    // "everything you've got" are the two most common intents.
    const handleKeyDown = (e) => {
        const KEY_DELTA = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
        if (!stops.length) return;
        const from = activeIndex >= 0 ? activeIndex : 0;
        let next;
        if (e.key in KEY_DELTA) next = from + KEY_DELTA[e.key];
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = stops.length - 1;
        else return;
        e.preventDefault();
        selectIndex(next);
    };

    if (!stops.length && !others.length) return null;

    return (
        <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }} data-testid="tier-slider">
            {/* Gauge only — no label. The needle already carries the setting,
                and the composer's icon row is where this belongs; the tier name
                is stated in full inside the panel. The name still reaches
                hover and assistive tech via title/aria-label. */}
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="model-tier-trigger"
                data-open={open ? '1' : '0'}
                style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: '34px', height: '34px', borderRadius: '9999px',
                    background: open ? 'var(--bg-secondary)' : 'transparent',
                    border: '1px solid',
                    borderColor: open ? 'var(--border-subtle)' : 'transparent',
                    color: 'var(--text-secondary)', cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                    boxShadow: open ? 'var(--shadow-sm)' : 'none',
                }}
                title={`${currentMeta.label} — ${currentMeta.desc || ''}`.trim()}
                aria-label={`Response depth: ${currentMeta.label}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                data-testid="tier-slider-trigger"
            >
                <TierGauge fraction={depthFraction} auto={isAuto} size={21} />
            </button>

            {open && (
                <div
                    ref={panelRef}
                    className="model-tier-panel absolute"
                    data-surface="opaque"
                    role="dialog"
                    aria-label="Response depth"
                    style={{
                        position: 'absolute', bottom: 'calc(100% + 8px)', zIndex: 100,
                        // Centred over the gauge, then nudged back inside the
                        // viewport if that would hang it off an edge.
                        left: '50%',
                        transform: `translateX(calc(-50% + ${edgeNudge}px))`,
                        width: 'min(320px, calc(100vw - 16px))',
                        border: '1px solid var(--border-default)',
                        borderRadius: '16px', padding: '16px',
                        background: 'var(--bg-card, #fff)',
                        boxShadow: 'var(--shadow-popover, 0 12px 36px rgba(15,23,42,0.18))',
                    }}
                >
                    {memory && <MemoryToggle enabled={!!memory.enabled} onToggle={memory.onToggle} />}

                    {/* The current choice, stated above the track: the label is
                        the control's output, the track is just how you move.
                        Padded clear of the memory toggle so a long tier name
                        can't run under it. */}
                    <div style={{ textAlign: 'center', marginBottom: '14px', padding: '0 26px' }}>
                        <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {currentMeta.label}
                        </div>
                        {currentMeta.desc && (
                            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                                {currentMeta.desc}
                            </div>
                        )}
                    </div>

                    {stops.length > 0 && (
                        <TierTrack
                            stops={stops}
                            activeIndex={activeIndex}
                            metaFor={metaFor}
                            onSelect={commit}
                            trackRef={trackRef}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerEnd={handlePointerEnd}
                            onKeyDown={handleKeyDown}
                        />
                    )}

                    {others.length > 0 && (
                        <OtherTierPills keys={others} value={value} metaFor={metaFor} onSelect={commit} />
                    )}
                </div>
            )}
        </div>
    );
}

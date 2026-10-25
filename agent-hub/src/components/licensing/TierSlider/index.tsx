import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MetaFor, TierSliderProps } from '../TierSlider.types';
import { TIER_META, customTierMeta, configuredTierKeys, tierCatalogId, DEPTH_TIER_KEYS } from '../tierMeta';
import scopedStorage from '../../../utils/scopedStorage';
import MemoryModeControl from '../../chat/memory/MemoryModeControl';
import AppEmoji from '../../icons/AppEmoji';
import useTranslation from '../../../hooks/useTranslation';
import { LEGACY_EFFORT_KEY, THUMB_PAD } from './TierSlider.constants';
import { TierTrack } from './TierTrack';
import { TierGauge } from './TierGauge';

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

/** Icon for a tier, in the same precedence the dropdown uses. */
function TierIcon({ tierKey, meta, className = 'w-3.5 h-3.5', style }: { tierKey: string; meta: ReturnType<MetaFor>; className?: string; style?: React.CSSProperties }) {
    if (meta.iconSrc) return <img src={meta.iconSrc} alt="" className={`${className} object-contain`} />;
    if (meta.Icon) return <meta.Icon className={className} style={style} />;
    return <AppEmoji id={tierCatalogId(tierKey)} default={meta.emoji} />;
}

/** Kinds of work that don't sit on the depth scale — Flow, Swarm, Write, custom. */
function OtherTierPills({ keys, value, metaFor, onSelect }: { keys: string[]; value: string; metaFor: MetaFor; onSelect: (key: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="[margin-top:14px] [padding-top:12px] [border-top:1px_solid_var(--border-subtle)]">
            <div className="[display:flex] [flex-wrap:wrap] [gap:6px]">
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
                            <span>{t(`tier.${key}`, meta.label)}</span>
                            {meta.beta && (
                                <span style={{
                                    fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.04em',
                                    padding: '1px 5px', borderRadius: '9999px',
                                    background: selected ? 'rgba(255,255,255,0.25)' : 'var(--bg-secondary)',
                                    color: selected ? '#fff' : 'var(--text-tertiary)',
                                }}>
                                    {t('chat.composer.beta_badge', 'beta')}
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
 * Memory control, parked in the panel's top-right corner.
 *
 * It lives here rather than in the composer's icon row because both settings
 * answer the same question — how much the assistant brings to the next turn —
 * and the row was getting long. Icon-only and unlabelled to stay quiet next to
 * the tier name; the state is carried by the icon, `title` and `aria-pressed`.
 *
 * `memory` is `{ mode, onChange, lock }` (On / Read only / Off for this chat).
 * The older `{ enabled, onToggle }` shape still works: enabled is On, not
 * enabled is Read only, which is what the old switch did.
 */
function MemoryToggle({ memory }: { memory: NonNullable<TierSliderProps['memory']> }) {
    const mode = memory.mode || (memory.enabled ? 'on' : 'read');
    const onChange = memory.onChange || (() => memory.onToggle?.());
    return (
        <span className="absolute top-[10px] right-[10px]">
            <MemoryModeControl
                mode={mode}
                onChange={onChange}
                lock={memory.lock || null}
                testId="tier-slider-memory-toggle"
            />
        </span>
    );
}

export default function TierSlider({ tiers = {}, value = 'fast', onChange, variant = 'input', memory = null }: TierSliderProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
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
        const bounds = rootRef.current?.closest('[data-popover-boundary]')?.getBoundingClientRect();
        const left = bounds ? bounds.left + margin : margin;
        const right = bounds ? bounds.right - margin : window.innerWidth - margin;
        if (r.left < left) setEdgeNudge(left - r.left);
        else if (r.right > right) setEdgeNudge(right - r.right);
    }, [open]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const metaFor = useCallback((key: string) => (
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

    const commit = useCallback((next: string | undefined) => {
        if (next && next !== value) onChange?.(next);
    }, [onChange, value]);

    const selectIndex = useCallback((i: number) => {
        if (!stops.length) return;
        commit(stops[Math.min(stops.length - 1, Math.max(0, i))]);
    }, [stops, commit]);

    // Measured against the same inset the dots are laid out on, or a click on
    // the far left would land between "before the first stop" and the first
    // stop's centre and read as a fractional position.
    const indexFromClientX = useCallback((clientX: number) => {
        const el = trackRef.current;
        if (!el || stops.length < 2) return 0;
        const r = el.getBoundingClientRect();
        const usable = Math.max(1, r.width - THUMB_PAD * 2);
        const ratio = Math.min(1, Math.max(0, (clientX - r.left - THUMB_PAD) / usable));
        return Math.round(ratio * (stops.length - 1));
    }, [stops.length]);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!stops.length) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        selectIndex(indexFromClientX(e.clientX));
    };
    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (draggingRef.current) selectIndex(indexFromClientX(e.clientX));
    };
    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
    };

    // APG slider keys. Home/End matter more here than usual: "cheapest" and
    // "everything you've got" are the two most common intents.
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const KEY_DELTA: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
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
        <div ref={rootRef} className="[position:relative] [display:inline-block]" data-testid="tier-slider">
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
                    aria-label={t('tier.response_depth', 'Response depth')}
                    style={{
                        position: 'absolute', bottom: 'calc(100% + 8px)', zIndex: 100,
                        // Centred over the gauge, then nudged back inside the
                        // viewport if that would hang it off an edge.
                        left: '50%',
                        transform: `translateX(calc(-50% + ${edgeNudge}px))`,
                        width: 'min(320px, calc(100vw - 16px), calc(100cqw - 24px))',
                        border: '1px solid var(--border-default)',
                        borderRadius: '16px', padding: '16px',
                        background: 'var(--bg-card, #fff)',
                        boxShadow: 'var(--shadow-popover, 0 12px 36px rgba(15,23,42,0.18))',
                    }}
                >
                    {memory && <MemoryToggle memory={memory} />}

                    {/* The current choice, stated above the track: the label is
                        the control's output, the track is just how you move.
                        Padded clear of the memory toggle so a long tier name
                        can't run under it. */}
                    <div className="[text-align:center] [margin-bottom:14px] [padding:0_26px]">
                        <div className="[font-size:15px] [font-weight:600] [color:var(--text-primary)]">
                            {currentMeta.label}
                        </div>
                        {currentMeta.desc && (
                            <div className="[font-size:12px] [color:var(--text-tertiary)] [margin-top:2px]">
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

// Shared "monitoring UI kit" for the Usage & Monitoring dashboard.
//
// Consolidates the visual primitives that the five tabs (Overview, Safety,
// Integrations, Feedback, Terminations) previously each re-implemented with
// small drifts: the big-number HERO, the small KPI cards (StatCard/MiniStat/
// KpiCard/Kpi → one MetricCard), the per-tab header, alert banner, chip
// filters, drill chips, show-more, collapsibles, etc.
//
// Inline-styled on purpose: it matches the dashboard's existing CSS-var
// vocabulary (--bg-secondary / --border-subtle / --text-muted) rather than the
// Tailwind/TSX shared components, so adopting it is a pure consolidation with
// no visual drift. No purple/violet/indigo anywhere.

import { AlertTriangle, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type {
    AlertBannerProps, CardProps, CollapsibleSectionProps, DrillChipProps, EmptyInlineProps, FilterChipBarProps,
    ListRowProps, MetricCardProps, MetricGridProps, MonitorHeroProps, SectionTitleProps, ShowMoreProps, SparklineProps,
    StatusPillProps, TabHeaderProps, TrendChipProps, ChipValue,
} from './kit.types';

// ── Spacing tokens ───────────────────────────────────────────────────────────
// One value per role, applied everywhere, to resolve the old 14-vs-16 outer-gap
// and 8/10/12/14 grid-gap drift.
export const TOKENS = {
    pagePad: 16,        // outer column gap between sections
    sectionGap: 14,     // gap inside a section block
    cardPad: '14px 16px',
    cardRadius: 12,
    heroRadius: 14,
    heroPad: 18,
    gridGap: 12,        // breakdown-grid gutter
    tileGap: 8,         // hero 2×2 tile gutter
};

// ── Sparkline ────────────────────────────────────────────────────────────────
const Sparkline = ({ values, color = '#0ea5e9', width = 60, height = 16 }: SparklineProps) => {
    if (!Array.isArray(values) || values.length < 2) return null;
    const max = Math.max(...values, 1);
    const points = values.map((v: number, i: number) => {
        const x = (i / (values.length - 1)) * (width - 2) + 1;
        const y = height - 1 - ((v / max) * (height - 2));
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return (
        <svg width={width} height={height} className="[display:block] [margin-top:2px]">
            <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
};

// ── StatusPill ───────────────────────────────────────────────────────────────
// The uppercase status chip (Excellent / Watch / Critical / active …). `color`
// must be a hex so the `${color}15` tint is valid.
const StatusPill = ({ label, color, dot = false }: StatusPillProps) => (
    <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 6,
        background: `${color}15`, color, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
        {dot && <span style={{ width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' }} />}
        {label}
    </span>
);

// ── TrendChip ────────────────────────────────────────────────────────────────
// Half-period delta arrow. `goodWhenDown` for higher-is-bad metrics (cost, PII);
// false for higher-is-good (sovereignty score). `display` is the formatted
// magnitude (e.g. "$3.20" or "5").
export const TrendChip = ({ delta, display, title, goodWhenDown = false }: TrendChipProps) => {
    if (delta == null) return null;
    const isGood = goodWhenDown ? delta < 0 : delta > 0;
    const color = delta === 0 ? '#94a3b8' : isGood ? '#10b981' : '#ef4444';
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '·';
    return (
        <span title={title} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 5,
            background: delta === 0 ? 'var(--bg-tertiary)' : `${color}15`, color, fontSize: 11, fontWeight: 800,
        }}>
            <span className="[font-size:13px]">{arrow}</span>{display}
        </span>
    );
};

// ── Card ─────────────────────────────────────────────────────────────────────
// Default: an edge-to-edge container (ListRows fill it). When `title`/`right` is
// given it pads itself and renders a header row (the old Terminations Card).
export const Card = ({ children, style, title, icon: Icon, right, pad }: CardProps) => {
    const padded = pad ?? (!!title || !!right);
    return (
        <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
            borderRadius: TOKENS.cardRadius, overflow: 'hidden',
            ...(padded ? { padding: TOKENS.cardPad } : null), ...style,
        }}>
            {(title || right) && (
                <div className="[display:flex] [align-items:center] [justify-content:space-between] [gap:8px] [margin-bottom:10px]">
                    <div className="[display:flex] [align-items:center] [gap:6px]">
                        {Icon && <Icon style={{ width: 14, height: 14, color: 'var(--accent-primary)', opacity: 0.8 }} />}
                        {title && <span className="[font-size:13px] [font-weight:700] [color:var(--text-primary)]">{title}</span>}
                    </div>
                    {right}
                </div>
            )}
            {children}
        </div>
    );
};

// ── MetricCard ───────────────────────────────────────────────────────────────
// Single replacement for StatCard / MiniStat / KpiCard / Kpi.
//   size 'sm' → horizontal, 18px, optional sparkline (old MiniStat; hero asides)
//   size 'md' → vertical,   22px, optional subtitle  (old Kpi / StatCard)
//   size 'lg' → vertical,   24px, optional subtitle  (old KpiCard)
export const MetricCard = ({ icon: Icon, label, value, color = '#0ea5e9', subtitle, spark, size = 'md', onClick }: MetricCardProps) => {
    if (size === 'sm') {
        return (
            <div onClick={onClick} style={{
                padding: '10px 12px', borderRadius: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)',
                display: 'flex', alignItems: 'center', gap: 10, cursor: onClick ? 'pointer' : 'default',
            }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${color}15`, flexShrink: 0 }}>
                    {Icon && <Icon style={{ width: 14, height: 14, color }} />}
                </div>
                <div className="[min-width:0] [flex:1]">
                    <div className="[font-size:9px] [font-weight:700] [text-transform:uppercase] [letter-spacing:0.06em] [color:var(--text-muted)]">{label}</div>
                    <div className="[font-size:18px] [font-weight:800] [color:var(--text-primary)] [letter-spacing:-0.02em]">{value}</div>
                    {Array.isArray(spark) && spark.length > 1 && <Sparkline values={spark} color={color} />}
                </div>
            </div>
        );
    }
    const valueSize = size === 'lg' ? 24 : 22;
    const chip = size === 'lg' ? 28 : 26;
    return (
        <div onClick={onClick} style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 12,
            padding: 14, display: 'flex', flexDirection: 'column', gap: 5, cursor: onClick ? 'pointer' : 'default',
        }}>
            <div className="[display:flex] [align-items:center] [gap:8px]">
                <div style={{ width: chip, height: chip, borderRadius: 7, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {Icon && <Icon style={{ width: 13, height: 13, color }} />}
                </div>
                <span className="[font-size:10px] [font-weight:700] [text-transform:uppercase] [letter-spacing:0.06em] [color:var(--text-muted)]">{label}</span>
            </div>
            <span style={{ fontSize: valueSize, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.05 }}>{value}</span>
            {subtitle && <span className="[font-size:11px] [color:var(--text-muted)]">{subtitle}</span>}
        </div>
    );
};

// ── MetricGrid ───────────────────────────────────────────────────────────────
// `cols` for a fixed N-column grid; `min` for an auto-fit minmax grid.
export const MetricGrid = ({ children, cols = 2, min, gap = TOKENS.gridGap }: MetricGridProps) => (
    <div style={{
        display: 'grid',
        gridTemplateColumns: min ? `repeat(auto-fit, minmax(${min}px, 1fr))` : `repeat(${cols}, minmax(0, 1fr))`,
        gap,
    }}>
        {children}
    </div>
);

// ── MonitorHero ──────────────────────────────────────────────────────────────
// THE big-number + KPI-grid pattern used by every tab. Left: eyebrow (+ infoTip)
// + headline value + status pill + trend chip + subline + optional children
// (stacked bars / explainer). Right: `aside` (a MetricGrid of MetricCards, or a
// trend chart). `accent` must be a hex (drives the gradient wash).
export const MonitorHero = ({
    accent = '#10b981', eyebrow, infoTip, value, valueColor, valueSize = 54,
    status, trend, subline, leftRatio = 1.2, children, aside,
}: MonitorHeroProps) => (
    <div style={{
        borderRadius: TOKENS.heroRadius, padding: TOKENS.heroPad, background: 'var(--bg-secondary)',
        border: '1px solid var(--border-subtle)', overflow: 'hidden', position: 'relative',
    }}>
        <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse at top left, ${accent}12, transparent 60%)`, pointerEvents: 'none' }} />
        <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: aside ? `${leftRatio}fr 1fr` : '1fr', gap: 24, alignItems: 'center' }}>
            <div>
                {eyebrow && (
                    <div className="[display:flex] [align-items:baseline] [gap:10px] [margin-bottom:4px]">
                        <span className="[font-size:11px] [font-weight:700] [text-transform:uppercase] [letter-spacing:0.08em] [color:var(--text-muted)]">{eyebrow}</span>
                        {infoTip}
                    </div>
                )}
                <div className="[display:flex] [align-items:baseline] [gap:12px] [margin-bottom:6px] [flex-wrap:wrap]">
                    <span style={{ fontSize: valueSize, fontWeight: 800, color: valueColor || accent, letterSpacing: '-0.04em', lineHeight: 1 }}>{value}</span>
                    {status && <StatusPill label={status.label} color={status.color} />}
                    {trend}
                </div>
                {subline && <div className="[font-size:11px] [color:var(--text-muted)] [font-weight:500]">{subline}</div>}
                {children}
            </div>
            {aside && <div>{aside}</div>}
        </div>
    </div>
);

// ── TabHeader ────────────────────────────────────────────────────────────────
// Uniform per-tab header (icon + title + description + status pill + actions).
// `iconColor` must be a hex (drives the chip tint). `actions` holds the range
// control / refresh on the panels.
export const TabHeader = ({ icon: Icon, iconColor = '#0ea5e9', title, description, status, actions }: TabHeaderProps) => (
    <div className="[display:flex] [align-items:center] [justify-content:space-between] [gap:16px] [flex-wrap:wrap]">
        <div className="[display:flex] [align-items:center] [gap:10px] [min-width:0] [flex:1]">
            {Icon && (
                <div style={{ width: 32, height: 32, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${iconColor}18`, flexShrink: 0 }}>
                    <Icon style={{ width: 16, height: 16, color: iconColor }} />
                </div>
            )}
            <div className="[min-width:0]">
                <div className="[display:flex] [align-items:center] [gap:8px]">
                    <h3 className="[font-size:15px] [font-weight:800] [color:var(--text-primary)] [margin:0] [letter-spacing:-0.01em]">{title}</h3>
                    {status && <StatusPill label={status.label} color={status.color} dot={status.dot} />}
                </div>
                {description && <p className="[font-size:11px] [color:var(--text-muted)] [margin:2px_0_0] [font-weight:400]">{description}</p>}
            </div>
        </div>
        {actions && <div className="[display:flex] [align-items:center] [gap:8px] [flex-wrap:wrap]">{actions}</div>}
    </div>
);

// ── AlertBanner ──────────────────────────────────────────────────────────────
// One action-required banner for all tabs (Feedback/Terminations no longer
// re-implement it). Spacing comes from the parent column gap (no marginBottom).
export const AlertBanner = ({ severity = 'amber', title = 'Action required', message, ctaLabel, onCta, icon: Icon = AlertTriangle }: AlertBannerProps) => {
    const c = severity === 'red' ? '#ef4444' : '#f59e0b';
    return (
        <div style={{
            padding: '12px 16px', borderRadius: 12, background: `${c}10`, border: `1px solid ${c}55`,
            display: 'flex', alignItems: 'center', gap: 12,
        }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: `${c}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon style={{ width: 16, height: 16, color: c }} />
            </div>
            <div className="[flex:1] [min-width:0]">
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: c }}>{title}</div>
                <div className="[font-size:13px] [font-weight:600] [color:var(--text-primary)] [margin-top:1px]">{message}</div>
            </div>
            {ctaLabel && onCta && (
                <button onClick={onCta} style={{
                    padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: c, color: 'white', fontWeight: 700, fontSize: 12,
                    display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
                }}>
                    {ctaLabel} <ChevronRight className="[width:14px] [height:14px]" />
                </button>
            )}
        </div>
    );
};

// ── SectionTitle ─────────────────────────────────────────────────────────────
export const SectionTitle = ({ children, icon: Icon, right }: SectionTitleProps) => (
    <div className="[display:flex] [align-items:center] [justify-content:space-between] [margin-bottom:8px]">
        <div className="[display:flex] [align-items:center] [gap:6px]">
            {Icon && <Icon style={{ width: 14, height: 14, color: 'var(--accent-primary)', opacity: 0.7 }} />}
            <span className="[font-size:12px] [font-weight:700] [color:var(--text-primary)]">{children}</span>
        </div>
        {right}
    </div>
);

// ── ListRow ──────────────────────────────────────────────────────────────────
export const ListRow = ({ children, onClick, style: s }: ListRowProps) => (
    <div
        onClick={onClick}
        style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '9px 14px', background: 'var(--bg-primary)',
            borderBottom: '1px solid var(--border-subtle)',
            cursor: onClick ? 'pointer' : 'default', transition: 'background 0.12s', ...s,
        }}
        onMouseEnter={e => { if (onClick) e.currentTarget.style.background = 'var(--bg-secondary)'; }}
        onMouseLeave={e => { if (onClick) e.currentTarget.style.background = 'var(--bg-primary)'; }}
    >
        {children}
    </div>
);

// ── FilterChipBar ────────────────────────────────────────────────────────────
// One chip group. Options: { value, label, icon?, color?, count? }. A `color`
// adds the colored-dot + tinted-active affordance (Safety); without it the chip
// is a flat accent toggle (Feedback). `size='sm'` for the compact egress/EU row.
export const FilterChipBar = ({ value, onChange, options, size = 'md' }: FilterChipBarProps) => {
    const pad = size === 'sm' ? '4px 10px' : '5px 12px';
    const fs = size === 'sm' ? 10 : 11;
    return (
        <div style={{ display: 'flex', gap: size === 'sm' ? 4 : 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {options.map(o => {
                const active = value === o.value;
                const color = o.color;
                const Icon = o.icon;
                return (
                    <button key={String(o.value)} onClick={() => onChange(o.value)} style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: pad, borderRadius: 8,
                        border: active && color ? `1.5px solid ${color}` : '1px solid var(--border-subtle)',
                        background: active ? (color ? `${color}10` : 'var(--accent-primary)') : 'var(--bg-secondary)',
                        color: active ? (color || '#fff') : 'var(--text-muted)',
                        fontWeight: active ? 700 : 500, fontSize: fs, cursor: 'pointer', transition: 'all 0.15s',
                    }}>
                        {color && <span style={{ width: 6, height: 6, borderRadius: 99, background: color, opacity: active ? 1 : 0.5 }} />}
                        {Icon && <Icon style={{ width: 12, height: 12 }} />}
                        {o.label}
                        {o.count != null && (
                            <span style={{
                                background: active ? (color ? `${color}20` : 'rgba(255,255,255,0.22)') : 'var(--bg-tertiary)',
                                padding: '1px 6px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                                color: active ? (color || '#fff') : 'var(--text-muted)',
                            }}>{o.count}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
};

// ── DrillChip ────────────────────────────────────────────────────────────────
// The removable "axis: label ✕" filter chip used by Safety + Integrations.
const DrillChip = ({ axis, label, onClear }: DrillChipProps) => {
    const { t } = useTranslation();
    return (
    <div className="[margin-bottom:8px]">
        <span className="[display:inline-flex] [align-items:center] [gap:8px] [padding:5px_6px_5px_10px] [border-radius:99px] [background:rgba(14,165,233,0.08)] [border:1px_solid_rgba(14,165,233,0.25)] [font-size:11px] [color:var(--text-primary)]">
            <span className="[font-size:9px] [font-weight:700] [text-transform:uppercase] [letter-spacing:0.06em] [color:#0ea5e9]">{axis}</span>
            <span className="[font-weight:700] [text-transform:capitalize]">{String(label || '').replace(/_/g, ' ')}</span>
            <button onClick={onClear} aria-label={t('usage.kit.clear_filter', 'Clear filter')} className="[width:18px] [height:18px] [border-radius:50%] [border:none] [cursor:pointer] [background:var(--bg-secondary)] [color:var(--text-secondary)] [display:inline-flex] [align-items:center] [justify-content:center] [font-size:11px]">✕</button>
        </span>
    </div>
    );
};

// ── ShowMore ─────────────────────────────────────────────────────────────────
export const ShowMore = ({ remaining, onMore, label = 'Show more' }: ShowMoreProps) => (
    <button onClick={onMore} className="[width:100%] [padding:10px_0] [border:none] [cursor:pointer] [background:var(--bg-tertiary)] [color:var(--text-muted)] [font-size:11px] [font-weight:600] [transition:all_0.15s] [border-top:1px_solid_var(--border-subtle)]"
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
        {label}{remaining != null ? ` (${remaining} remaining)` : ''}
    </button>
);

// ── CollapsibleSection ───────────────────────────────────────────────────────
// Wraps a dense block under a click-to-expand header with a count badge, so the
// data is preserved but doesn't crowd the page by default.
export const CollapsibleSection = ({ title, icon: Icon, count, defaultOpen = false, right, children }: CollapsibleSectionProps) => {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div>
            <div className="[display:flex] [align-items:center] [justify-content:space-between] [margin-bottom:8px] [gap:8px]">
                <button onClick={() => setOpen(o => !o)} className="[display:flex] [align-items:center] [gap:6px] [background:none] [border:none] [cursor:pointer] [padding:0]">
                    <ChevronRight style={{ width: 14, height: 14, color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
                    {Icon && <Icon style={{ width: 14, height: 14, color: 'var(--accent-primary)', opacity: 0.7 }} />}
                    <span className="[font-size:12px] [font-weight:700] [color:var(--text-primary)]">{title}</span>
                    {count != null && <span className="[font-size:10px] [font-weight:700] [color:var(--text-muted)] [background:var(--bg-tertiary)] [padding:1px_7px] [border-radius:8px]">{count}</span>}
                </button>
                {open && right}
            </div>
            {open && children}
        </div>
    );
};

// ── EmptyInline ──────────────────────────────────────────────────────────────
// Small "no data" line. `boxed` adds the bg-tertiary placard (Feedback/
// Terminations); default plain (inside an existing Card).
export const EmptyInline = ({ text, icon: Icon, boxed = false }: EmptyInlineProps) => (
    <div style={{
        padding: '22px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        ...(boxed ? { borderRadius: 10, background: 'var(--bg-tertiary)' } : null),
    }}>
        {Icon && <Icon style={{ width: 18, height: 18, opacity: 0.7 }} />}
        <span>{text}</span>
    </div>
);

// Shared "monitoring UI kit" of the Usage & Monitoring page: the pieces the
// Adoption drill-down and the Spend sub-tabs still share (Sparkline, TrendChip,
// Card, MetricCard, MetricGrid, AlertBanner, SectionTitle, FilterChipBar,
// ShowMore, EmptyInline). New layout goes in `./shell` (Tailwind primitives:
// SubTabs, KpiTile, DeltaPill, SegmentBar, MoreLink, Swatch).
//
// Inline-styled on purpose: it matches the dashboard's existing CSS-var
// vocabulary (--bg-secondary / --border-subtle / --text-muted) rather than the
// Tailwind/TSX shared components, so adopting it is a pure consolidation with
// no visual drift. No purple/violet/indigo anywhere.

import { AlertTriangle, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type {
    AlertBannerProps, CardProps, EmptyInlineProps, FilterChipBarProps, MetricCardProps, MetricGridProps,
    SectionTitleProps, ShowMoreProps, SparklineProps, TrendChipProps, ChipValue,
} from './kit.types';

// ── Spacing tokens ───────────────────────────────────────────────────────────
// One value per role, applied everywhere, to resolve the old 14-vs-16 outer-gap
// and 8/10/12/14 grid-gap drift.
const TOKENS = {
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
export const Sparkline = ({ values, color = '#0ea5e9', width = 60, height = 16 }: SparklineProps) => {
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

// ── FilterChipBar ────────────────────────────────────────────────────────────
// One chip group. Options: { value, label, icon?, color?, count? }. A `color`
// adds the colored-dot + tinted-active affordance (Safety); without it the chip
// is a flat accent toggle (Feedback). `size='sm'` for the compact egress/EU row.
export const FilterChipBar = ({ value, onChange, options, size = 'md' }: FilterChipBarProps) => {
    const pad = size === 'sm' ? '4px 10px' : '5px 12px';
    const fs = size === 'sm' ? 10 : 11;
    return (
        <div className={`[display:flex] [flex-wrap:wrap] [align-items:center] ${size === 'sm' ? '[gap:4px]' : '[gap:6px]'}`}>
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

// ── ShowMore ─────────────────────────────────────────────────────────────────
export const ShowMore = ({ remaining, onMore, label = 'Show more' }: ShowMoreProps) => (
    <button onClick={onMore} className="[width:100%] [padding:10px_0] [border:none] [cursor:pointer] [background:var(--bg-tertiary)] [color:var(--text-muted)] [font-size:11px] [font-weight:600] [transition:all_0.15s] [border-top:1px_solid_var(--border-subtle)]"
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
        {label}{remaining != null ? ` (${remaining} remaining)` : ''}
    </button>
);

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

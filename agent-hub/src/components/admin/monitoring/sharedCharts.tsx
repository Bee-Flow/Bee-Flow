import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { COLORS, MODEL_COLORS, fmt, fmtCost } from './sharedFormat';
import { Empty } from './sharedBase';

// ── InOut Bar (stacked input/output bar) ────────────────────────────────────

interface InOutBarProps {
    input?: number | null;
    output?: number | null;
    height?: number;
    style?: CSSProperties;
}

export function InOutBar({ input, output, height = 5, style }: InOutBarProps) {
    const total = (input || 0) + (output || 0);
    if (total === 0) return <div style={{ width: '100%', height, borderRadius: 99, background: 'var(--bg-tertiary, rgba(255,255,255,0.06))', ...style }} />;
    const inputPct = ((input || 0) / total) * 100;
    return (
        <div style={{ width: '100%', height, borderRadius: 99, background: 'var(--bg-tertiary, rgba(255,255,255,0.06))', overflow: 'hidden', display: 'flex', ...style }}>
            <div style={{ height: '100%', width: `${inputPct}%`, background: COLORS.blue, borderRadius: '99px 0 0 99px', transition: 'width 0.4s ease' }} />
            <div style={{ height: '100%', flex: 1, background: COLORS.amber, borderRadius: '0 99px 99px 0', transition: 'width 0.4s ease' }} />
        </div>
    );
}

interface InOutLabelProps {
    input?: number | null;
    output?: number | null;
    inputCost?: number | null;
    outputCost?: number | null;
    showCost?: boolean;
}

export function InOutLabel({ input, output, inputCost, outputCost, showCost }: InOutLabelProps) {
    return (
        <div style={{ display: 'flex', gap: showCost ? 14 : 10, fontSize: '11px', color: 'var(--text-muted, #888)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ width: 6, height: 6, borderRadius: 2, background: COLORS.blue, display: 'inline-block' }} />
                <span style={{ color: COLORS.blue, fontWeight: 600 }}>{fmt(input)}</span>
                {showCost && inputCost != null && <span style={{ color: COLORS.blue, opacity: 0.7, fontWeight: 500 }}>({fmtCost(inputCost)})</span>}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <span style={{ width: 6, height: 6, borderRadius: 2, background: COLORS.amber, display: 'inline-block' }} />
                <span style={{ color: COLORS.amber, fontWeight: 600 }}>{fmt(output)}</span>
                {showCost && outputCost != null && <span style={{ color: COLORS.amber, opacity: 0.7, fontWeight: 500 }}>({fmtCost(outputCost)})</span>}
            </span>
        </div>
    );
}

// ── SVG Area Chart ──────────────────────────────────────────────────────────

/** One point of a timeline series: a period label plus numeric (or string) metric columns. */
export interface ChartRow {
    period?: string;
    [key: string]: number | string | undefined;
}

interface SvgAreaChartProps {
    data: ChartRow[] | null | undefined;
    yKey?: string;
    label?: string;
    color?: string;
    height?: number;
    formatY?: (n: number) => string;
    formatLabel?: (d: ChartRow) => string;
}

export function SvgAreaChart({ data, yKey = 'total_tokens', label = 'value', color = COLORS.primary, height = 140, formatY = fmt, formatLabel }: SvgAreaChartProps) {
    const [hover, setHover] = useState<number | null>(null);

    if (!data || data.length === 0) return <Empty text="No data to display" />;

    const maxY = Math.max(...data.map(d => Number(d[yKey] || 0)), 1);
    const points = data.map((d, i) => {
        const x = (i / Math.max(data.length - 1, 1)) * 100;
        const y = 100 - (Number(d[yKey] || 0) / maxY) * 90; // 90% max to leave top padding
        return { x, y, d };
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const areaPath = `${linePath} L100,100 L0,100 Z`;

    return (
        <div style={{ position: 'relative', height }}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                <defs>
                    <linearGradient id={`grad-${yKey}-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.25" />
                        <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                    </linearGradient>
                </defs>
                <path d={areaPath} fill={`url(#grad-${yKey}-${color.replace('#', '')})`} />
                <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                {/* Hover zones */}
                {points.map((p, i) => (
                    <rect
                        key={i}
                        x={i === 0 ? 0 : (points[i - 1].x + p.x) / 2}
                        y="0"
                        width={i === 0 ? (points[1]?.x || 100) / 2 : i === points.length - 1 ? 100 - (points[i - 1].x + p.x) / 2 : (points[i + 1].x - points[i - 1].x) / 2}
                        height="100"
                        fill="transparent"
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                        style={{ cursor: 'crosshair' }}
                    />
                ))}
                {/* Hover dot */}
                {hover != null && points[hover] && (
                    <circle cx={points[hover].x} cy={points[hover].y} r="3" fill={color} stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                )}
            </svg>
            {/* Hover tooltip */}
            {hover != null && points[hover] && (
                <div style={{
                    position: 'absolute',
                    left: `${points[hover].x}%`, top: '-6px',
                    transform: 'translateX(-50%)',
                    padding: '4px 10px', borderRadius: '8px',
                    background: 'var(--bg-primary, #0f0f1a)',
                    border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
                    fontSize: '11px', fontWeight: 600, color: 'var(--text-primary, #fff)',
                    whiteSpace: 'nowrap', pointerEvents: 'none',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    zIndex: 10,
                }}>
                    <div style={{ color }}>{formatY(Number(points[hover].d[yKey] || 0))}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted, #888)', marginTop: '1px' }}>
                        {formatLabel ? formatLabel(points[hover].d) : points[hover].d.period || ''}
                    </div>
                </div>
            )}
            {/* X-axis labels */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted, #666)' }}>{data[0]?.period?.slice(5) || ''}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted, #666)' }}>{data[data.length - 1]?.period?.slice(5) || ''}</span>
            </div>
        </div>
    );
}

// ── SVG Donut Chart ─────────────────────────────────────────────────────────

export interface DonutItem {
    value?: number;
    label?: ReactNode;
    color?: string;
}

interface DonutChartProps {
    items: DonutItem[];
    size?: number;
    centerLabel?: ReactNode;
    centerValue?: ReactNode;
}

export function DonutChart({ items, size = 160, centerLabel, centerValue }: DonutChartProps) {
    const total = items.reduce((s, i) => s + (i.value || 0), 0) || 1;
    let cumulative = 0;

    const arcs = items.map((item, idx) => {
        const pct = (item.value || 0) / total;
        const startAngle = cumulative * 360;
        cumulative += pct;
        const endAngle = cumulative * 360;
        const large = pct > 0.5 ? 1 : 0;
        const r = 40;
        const cx = 50, cy = 50;
        const toRad = (deg: number) => (deg - 90) * (Math.PI / 180);
        const x1 = cx + r * Math.cos(toRad(startAngle));
        const y1 = cy + r * Math.sin(toRad(startAngle));
        const x2 = cx + r * Math.cos(toRad(endAngle - 0.1));
        const y2 = cy + r * Math.sin(toRad(endAngle - 0.1));
        const path = `M${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2}`;
        return { ...item, path, pct, color: item.color || MODEL_COLORS[idx % MODEL_COLORS.length] };
    });

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <svg width={size} height={size} viewBox="0 0 100 100">
                {arcs.map((arc, i) => (
                    <path key={i} d={arc.path} fill="none" stroke={arc.color} strokeWidth="14" strokeLinecap="round"
                        style={{ transition: 'stroke-dashoffset 0.4s ease' }} />
                ))}
                {centerLabel && (
                    <>
                        <text x="50" y="46" textAnchor="middle" fill="var(--text-muted, #888)" fontSize="6" fontWeight="600" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {centerLabel}
                        </text>
                        <text x="50" y="58" textAnchor="middle" fill="var(--text-primary, #fff)" fontSize="12" fontWeight="800">
                            {centerValue}
                        </text>
                    </>
                )}
            </svg>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
                {arcs.map((arc, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: arc.color, flexShrink: 0 }} />
                        <span style={{ color: 'var(--text-secondary, #aaa)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '110px' }}>
                            {arc.label}
                        </span>
                        <span style={{ color: 'var(--text-muted, #888)', fontWeight: 600, marginLeft: 'auto' }}>
                            {(arc.pct * 100).toFixed(0)}%
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}


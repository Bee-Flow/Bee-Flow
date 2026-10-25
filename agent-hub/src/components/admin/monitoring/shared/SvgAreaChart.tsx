import { useState } from 'react';
import type { EmptyProps, SvgAreaChartProps } from '../shared.types';

export function fmt(n: number | null | undefined) {
    if (n == null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.round(n));
}

export const COLORS = {
    primary: '#6366f1',
    purple: '#8b5cf6',
    blue: '#3b82f6',
    green: '#10b981',
    emerald: '#059669',
    amber: '#f59e0b',
    orange: '#f97316',
    rose: '#f43f5e',
    pink: '#ec4899',
    cyan: '#06b6d4',
    teal: '#14b8a6',
};

export function Empty({ text }: EmptyProps) {
    return (
        <div className="[padding:2.5rem_1rem] [text-align:center] [color:var(--text-muted,#666)] [font-size:13px] [border-radius:10px] [background:var(--bg-tertiary,rgba(255,255,255,0.02))]">
            {text}
        </div>
    );
}

export function SvgAreaChart({ data, yKey = 'total_tokens', label = 'value', color = COLORS.primary, height = 140, formatY = fmt, formatLabel }: SvgAreaChartProps) {
    const [hover, setHover] = useState<number | null>(null);
    if (!data || data.length === 0) return <Empty text="No data to display" />;
    const maxY = Math.max(...data.map(d => d[yKey] || 0), 1);
    const points = data.map((d, i) => {
        const x = (i / Math.max(data.length - 1, 1)) * 100;
        const y = 100 - ((d[yKey] || 0) / maxY) * 90; // 90% max to leave top padding
        return { x, y, d };
    });
    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const areaPath = `${linePath} L100,100 L0,100 Z`;
    return (
        <div style={{ position: 'relative', height }}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-[100%] h-[100%] [overflow:visible]">
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
                        className="[cursor:crosshair]"
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
                    <div style={{ color }}>{formatY(points[hover].d[yKey] || 0)}</div>
                    <div className="[font-size:10px] [color:var(--text-muted,#888)] [margin-top:1px]">
                        {formatLabel ? formatLabel(points[hover].d) : points[hover].d.period || ''}
                    </div>
                </div>
            )}
            {/* X-axis labels */}
            <div className="[display:flex] [justify-content:space-between] [margin-top:6px]">
                <span className="[font-size:10px] [color:var(--text-muted,#666)]">{data[0]?.period?.slice(5) || ''}</span>
                <span className="[font-size:10px] [color:var(--text-muted,#666)]">{data[data.length - 1]?.period?.slice(5) || ''}</span>
            </div>
        </div>
    );
}

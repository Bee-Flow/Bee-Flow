import type { DonutChartProps } from '../shared.types';
import { MODEL_COLORS } from './ModelRow';

export function DonutChart({ items, size = 160, centerLabel, centerValue }: DonutChartProps) {
    const total = items.reduce((s, i) => s + (i.value || 0), 0) || 1;
    const starts: number[] = [];
    items.reduce((acc, i) => { starts.push(acc); return acc + (i.value || 0) / total; }, 0);
    const arcs = items.map((item, idx) => {
        const pct = (item.value || 0) / total;
        const startAngle = starts[idx] * 360;
        const endAngle = (starts[idx] + pct) * 360;
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
        <div className="[display:flex] [align-items:center] [gap:20px]">
            <svg width={size} height={size} viewBox="0 0 100 100">
                {arcs.map((arc, i) => (
                    <path key={i} d={arc.path} fill="none" stroke={arc.color} strokeWidth="14" strokeLinecap="round"
                        className="[transition:stroke-dashoffset_0.4s_ease]" />
                ))}
                {centerLabel && (
                    <>
                        <text x="50" y="46" textAnchor="middle" fill="var(--text-muted, #888)" fontSize="6" fontWeight="600" className="[text-transform:uppercase] [letter-spacing:0.05em]">
                            {centerLabel}
                        </text>
                        <text x="50" y="58" textAnchor="middle" fill="var(--text-primary, #fff)" fontSize="12" fontWeight="800">
                            {centerValue}
                        </text>
                    </>
                )}
            </svg>
            <div className="[display:flex] [flex-direction:column] [gap:6px] min-w-[0]">
                {arcs.map((arc, i) => (
                    <div key={i} className="[display:flex] [align-items:center] [gap:6px] [font-size:11px]">
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: arc.color, flexShrink: 0 }} />
                        <span className="[color:var(--text-secondary,#aaa)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] max-w-[110px]">
                            {arc.label}
                        </span>
                        <span className="[color:var(--text-muted,#888)] [font-weight:600] [margin-left:auto]">
                            {(arc.pct * 100).toFixed(0)}%
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

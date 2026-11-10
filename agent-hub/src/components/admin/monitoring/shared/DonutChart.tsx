import type { DonutChartProps } from '../shared.types';
import { MODEL_COLORS, SeriesDot } from './ModelRow';

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
        <div className="flex flex-wrap items-center gap-5">
            <svg width={size} height={size} viewBox="0 0 100 100" className="shrink-0">
                {arcs.map((arc, i) => (
                    <path key={i} d={arc.path} fill="none" stroke={arc.color} strokeWidth="14" strokeLinecap="round" />
                ))}
                {centerLabel && (
                    <>
                        <text x="50" y="46" textAnchor="middle" fill="var(--text-tertiary)" fontSize="6" fontWeight="600" className="uppercase tracking-[0.05em]">
                            {centerLabel}
                        </text>
                        <text x="50" y="58" textAnchor="middle" fill="var(--text-primary)" fontSize="12" fontWeight="700">
                            {centerValue}
                        </text>
                    </>
                )}
            </svg>
            <ul className="flex min-w-0 flex-col gap-1.5">
                {arcs.map((arc, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[11px]">
                        <SeriesDot color={arc.color} square />
                        <span className="max-w-[140px] truncate text-[var(--text-secondary)]">{arc.label}</span>
                        <span className="ml-auto pl-2 font-semibold tabular-nums text-[var(--text-tertiary)]">{(arc.pct * 100).toFixed(0)}%</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

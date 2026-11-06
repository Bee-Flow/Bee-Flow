interface MiniTrendProps {
    values: number[];
}

/** A sparkline for a tile: decorative, the tile's text carries the figure. */
export function MiniTrend({ values }: MiniTrendProps) {
    if (values.length < 2) return <div className="h-7" aria-hidden="true" />;
    const max = Math.max(...values, 1);
    const points = values
        .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(26 - (v / max) * 24).toFixed(1)}`)
        .join(' ');
    return (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" className="h-7 w-full overflow-visible">
            <polyline
                points={points}
                className="fill-none stroke-[var(--accent-primary)] stroke-[1.5] [stroke-linecap:round] [stroke-linejoin:round] [vector-effect:non-scaling-stroke]"
            />
        </svg>
    );
}

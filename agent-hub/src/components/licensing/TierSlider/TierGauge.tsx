import { GAUGE_START_DEG, GAUGE_SWEEP_DEG, NEEDLE_EASING, ARC_EASING, GAUGE_RADIUS, GAUGE_ARC_LEN } from './TierSlider.constants';

/** Degrees are clockwise from 12 o'clock, which is how a gauge is read. */
function polarPoint(cx: number, cy: number, r: number, deg: number) {
    const rad = (deg - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
    const start = polarPoint(cx, cy, r, fromDeg);
    const end = polarPoint(cx, cy, r, toDeg);
    const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

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
export function TierGauge({ fraction, auto = false, size = 17 }: { fraction: number | null; auto?: boolean; size?: number }) {
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
            className="[flex-shrink:0] [display:block]"
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
                    className="[font-size:11px] [font-weight:700] [letter-spacing:-0.02em]"
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

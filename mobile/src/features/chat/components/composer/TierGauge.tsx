/**
 * The speedometer on the tier trigger. `fraction` is 0–1 along the depth
 * scale; null means the current tier is not on it (Flow/Swarm/Write) — needle
 * at rest, arc unfilled. Auto drops the needle entirely: the whole arc lights
 * dimmed and an "A" takes the pivot's place, because Auto means "pick for me"
 * and a needle position would invent a depth. All the web's own reasoning.
 */

import React from 'react';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import {
    arcPath,
    GAUGE_ARC_LEN,
    GAUGE_RADIUS,
    GAUGE_START_DEG,
    GAUGE_SWEEP_DEG,
    polarPoint,
} from '@/features/chat/model/tierGeometry';

const CENTER = { x: 12, y: 12 };
const TRACK = arcPath(CENTER, GAUGE_RADIUS, GAUGE_START_DEG, GAUGE_START_DEG + GAUGE_SWEEP_DEG);

export function TierGauge({
    fraction,
    auto,
    size,
    accent,
    muted,
}: {
    fraction: number | null;
    auto: boolean;
    size: number;
    accent: string;
    muted: string;
}) {
    const f = typeof fraction === 'number' ? Math.min(1, Math.max(0, fraction)) : null;
    const inactive = f === null && !auto;
    const filled = auto ? 1 : (f ?? 0);
    const tip = polarPoint(CENTER, GAUGE_RADIUS - 2.4, GAUGE_START_DEG + GAUGE_SWEEP_DEG * (f ?? 0));
    const needle = inactive ? muted : accent;

    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path d={TRACK} stroke={muted} strokeOpacity={0.28} strokeWidth={2.4} strokeLinecap="round" fill="none" />
            {!inactive ? (
                <Path
                    d={TRACK}
                    stroke={accent}
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    fill="none"
                    strokeDasharray={`${GAUGE_ARC_LEN}`}
                    strokeDashoffset={GAUGE_ARC_LEN * (1 - filled)}
                    strokeOpacity={auto ? 0.45 : 1}
                />
            ) : null}
            {auto ? (
                <SvgText
                    x={CENTER.x}
                    y={CENTER.y}
                    textAnchor="middle"
                    alignmentBaseline="central"
                    fill={accent}
                    fontSize={11}
                    fontWeight="700"
                >
                    A
                </SvgText>
            ) : (
                <>
                    <Line
                        x1={CENTER.x}
                        y1={CENTER.y}
                        x2={tip.x}
                        y2={tip.y}
                        stroke={needle}
                        strokeOpacity={inactive ? 0.4 : 1}
                        strokeWidth={2}
                        strokeLinecap="round"
                    />
                    <Circle cx={CENTER.x} cy={CENTER.y} r={1.7} fill={needle} fillOpacity={inactive ? 0.4 : 1} />
                </>
            )}
        </Svg>
    );
}

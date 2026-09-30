/**
 * A pie or donut: slices clockwise from twelve o'clock in the theme's chart
 * colours, each outlined in the card's colour so neighbours stay apart (the
 * web's `arc: { stroke: bgTertiary, strokeWidth: 2 }`).
 */

import React from 'react';
import Svg, { Path } from 'react-native-svg';

import type { Theme } from '@/core/theme/ThemeProvider';

import { arcPath, CHART_HEIGHT, sliceAngles } from './chartGeometry';
import type { ArcChart as Model } from './chartModel';

export function ArcChart({ model, width, theme, label }: { model: Model; width: number; theme: Theme; label: string }) {
    const angles = sliceAngles(model.slices.map((s) => s.value));
    const outer = Math.max(10, Math.min(width, CHART_HEIGHT) / 2 - 6);
    const inner = Math.min(Math.max(0, model.innerRadius), outer * 0.9);
    const cx = width / 2;
    const cy = CHART_HEIGHT / 2;
    return (
        <Svg width={width} height={CHART_HEIGHT} accessible accessibilityRole="image" accessibilityLabel={label}>
            {model.slices.map((slice, i) => (
                <Path
                    key={i}
                    d={arcPath({ cx, cy }, { inner, outer }, angles[i]?.start ?? 0, angles[i]?.end ?? 0)}
                    fill={slice.color}
                    stroke={theme.colors.bgTertiary}
                    strokeWidth={2}
                />
            ))}
        </Svg>
    );
}

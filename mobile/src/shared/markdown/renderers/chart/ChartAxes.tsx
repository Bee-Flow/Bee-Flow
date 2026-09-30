/**
 * A cartesian chart's axes, in the web's chart config colours: grid lines on
 * the subtle border at each measure tick, the domain line, tick labels in the
 * secondary ink, and the axis titles in the primary ink. Category labels are
 * slanted 45° when they would collide (the web's mobile `labelAngle: -45`).
 */

import React from 'react';
import { G, Line, Text as SvgText } from 'react-native-svg';

import type { Theme } from '@/core/theme/ThemeProvider';

import { LABEL_SIZE, type Scales } from './chartGeometry';
import type { CartesianChart } from './chartModel';
import { formatDate } from './scales';

interface AxisProps {
    model: CartesianChart;
    scales: Scales;
    width: number;
    height: number;
    theme: Theme;
    measureLabels: string[];
}

function clip(text: string, max = 18): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dimensionTicks(model: CartesianChart, scales: Scales): { at: number; label: string }[] {
    const dim = model.dimension;
    if (dim.scale === 'band') {
        return dim.categories.map((key, i) => {
            const { at, band } = scales.place({ key, at: 0, value: 0, base: 0 });
            return { at: at + band / 2, label: dim.labels[i] ?? key };
        });
    }
    const span = dim.domain[1] - dim.domain[0];
    return dim.ticks.map((tick) => ({
        at: scales.place({ key: String(tick), at: tick, value: 0, base: 0 }).at,
        label: dim.scale === 'time' ? formatDate(tick, span) : String(tick),
    }));
}

export function ChartAxes({ model, scales, width, height, theme, measureLabels }: AxisProps) {
    const { box } = scales;
    const label = theme.colors.textSecondary;
    const grid = theme.colors.borderSubtle;
    const domain = theme.colors.borderDefault;
    const dims = dimensionTicks(model, scales);
    const h = model.horizontal;
    const plotBottom = height - box.bottom;
    return (
        <G>
            {model.measure.ticks.map((tick, i) => {
                const at = scales.measure(tick);
                return h ? (
                    <G key={`m${i}`}>
                        <Line x1={at} x2={at} y1={box.top} y2={plotBottom} stroke={grid} strokeWidth={1} />
                        <SvgText x={at} y={plotBottom + LABEL_SIZE + 4} fontSize={LABEL_SIZE} fill={label} textAnchor="middle">
                            {measureLabels[i]}
                        </SvgText>
                    </G>
                ) : (
                    <G key={`m${i}`}>
                        <Line x1={box.left} x2={width - box.right} y1={at} y2={at} stroke={grid} strokeWidth={1} />
                        <SvgText x={box.left - 5} y={at + LABEL_SIZE / 3} fontSize={LABEL_SIZE} fill={label} textAnchor="end">
                            {measureLabels[i]}
                        </SvgText>
                    </G>
                );
            })}
            {h ? (
                <Line x1={box.left} x2={box.left} y1={box.top} y2={plotBottom} stroke={domain} strokeWidth={1} />
            ) : (
                <Line x1={box.left} x2={width - box.right} y1={plotBottom} y2={plotBottom} stroke={domain} strokeWidth={1} />
            )}
            {dims.map((tick, i) =>
                h ? (
                    <SvgText key={`d${i}`} x={box.left - 5} y={tick.at + LABEL_SIZE / 3} fontSize={LABEL_SIZE} fill={label} textAnchor="end">
                        {clip(tick.label)}
                    </SvgText>
                ) : (
                    <SvgText
                        key={`d${i}`}
                        x={tick.at}
                        y={plotBottom + LABEL_SIZE + 3}
                        fontSize={LABEL_SIZE}
                        fill={label}
                        textAnchor={scales.slanted ? 'end' : 'middle'}
                        rotation={scales.slanted ? -45 : 0}
                        origin={`${tick.at}, ${plotBottom + LABEL_SIZE + 3}`}
                    >
                        {clip(tick.label)}
                    </SvgText>
                ),
            )}
            <AxisTitles model={model} width={width} height={height} theme={theme} scales={scales} />
        </G>
    );
}

function AxisTitles({ model, width, height, theme, scales }: Omit<AxisProps, 'measureLabels'>) {
    const { box } = scales;
    const leftTitle = model.horizontal ? model.dimensionTitle : model.measureTitle;
    const bottomTitle = model.horizontal ? model.measureTitle : model.dimensionTitle;
    const midY = (box.top + height - box.bottom) / 2;
    const midX = (box.left + width - box.right) / 2;
    const fill = theme.colors.textPrimary;
    return (
        <G>
            {leftTitle ? (
                <SvgText x={10} y={midY} fontSize={LABEL_SIZE + 1} fontWeight="600" fill={fill} textAnchor="middle" rotation={-90} origin={`10, ${midY}`}>
                    {clip(leftTitle, 30)}
                </SvgText>
            ) : null}
            {bottomTitle ? (
                <SvgText x={midX} y={height - 3} fontSize={LABEL_SIZE + 1} fontWeight="600" fill={fill} textAnchor="middle">
                    {clip(bottomTitle, 40)}
                </SvgText>
            ) : null}
        </G>
    );
}

/**
 * A bar, line, area or point chart (or a layer of them) in react-native-svg,
 * at the width it is given and the web's mobile height.
 */

import React from 'react';
import Svg from 'react-native-svg';

import type { Theme } from '@/core/theme/ThemeProvider';

import { ChartAxes } from './ChartAxes';
import { buildScales, CHART_HEIGHT } from './chartGeometry';
import { ChartMarks } from './ChartMarks';
import type { CartesianChart as Model } from './chartModel';
import { formatNumber, formatPercent } from './scales';

export function CartesianChart({ model, width, theme, label }: { model: Model; width: number; theme: Theme; label: string }) {
    const measureLabels = model.measure.ticks.map((tick) => (model.measure.percent ? formatPercent(tick) : formatNumber(tick)));
    const scales = buildScales(model, width, CHART_HEIGHT, measureLabels);
    return (
        <Svg width={width} height={CHART_HEIGHT} accessible accessibilityRole="image" accessibilityLabel={label}>
            <ChartAxes model={model} scales={scales} width={width} height={CHART_HEIGHT} theme={theme} measureLabels={measureLabels} />
            {model.layers.map((_, i) => (
                <ChartMarks key={i} model={model} index={i} scales={scales} />
            ))}
        </Svg>
    );
}

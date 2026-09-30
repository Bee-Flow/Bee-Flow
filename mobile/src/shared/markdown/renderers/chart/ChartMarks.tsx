/**
 * One cartesian layer's marks, as the web's chart config draws them: bars
 * with a 2px end radius, 2px lines, areas at 30% over their base, and filled
 * points (on a line only when the spec asks for them).
 */

import React from 'react';
import { Circle, G, Path, Rect } from 'react-native-svg';

import { areaPath, barRects, linePath, seriesXY, type Scales } from './chartGeometry';
import type { CartesianChart } from './chartModel';

const POINT_RADIUS = 3;

export function ChartMarks({ model, index, scales }: { model: CartesianChart; index: number; scales: Scales }) {
    const layer = model.layers[index];
    if (!layer) return null;
    if (layer.mark === 'bar') {
        return (
            <G>
                {barRects(model, index, scales).map((r, i) => (
                    <Rect key={i} x={r.x} y={r.y} width={Math.max(0, r.width)} height={Math.max(0, r.height)} rx={2} fill={r.color} />
                ))}
            </G>
        );
    }
    return (
        <G>
            {layer.series.map((series, si) => {
                const tops = seriesXY(model, series.points, scales);
                const dots = layer.mark === 'point' || layer.showPoints;
                return (
                    <G key={si}>
                        {layer.mark === 'area' ? (
                            <Path d={areaPath(tops, seriesXY(model, series.points, scales, false))} fill={series.color} fillOpacity={0.3} />
                        ) : null}
                        {layer.mark !== 'point' ? <Path d={linePath(tops)} stroke={series.color} strokeWidth={2} fill="none" /> : null}
                        {dots ? tops.map(([x, y], i) => <Circle key={i} cx={x} cy={y} r={POINT_RADIUS} fill={series.color} />) : null}
                    </G>
                );
            })}
        </G>
    );
}

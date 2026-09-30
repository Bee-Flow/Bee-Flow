/**
 * A CSS `linear-gradient` background for a view: an absolutely positioned
 * react-native-svg rectangle behind the view's content. `angle` is the CSS
 * one: 135deg runs from the top left to the bottom right, 0deg (`to top`)
 * from the bottom up.
 */

import React, { useId } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

export interface GradientStop {
    color: string;
    opacity?: number;
}

/** The gradient line's end points in the unit box, for a CSS angle. */
export function gradientVector(angle: number): { x1: number; y1: number; x2: number; y2: number } {
    const rad = (angle * Math.PI) / 180;
    const dx = Math.sin(rad) / 2;
    const dy = -Math.cos(rad) / 2;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return { x1: round(0.5 - dx), y1: round(0.5 - dy), x2: round(0.5 + dx), y2: round(0.5 + dy) };
}

export function GradientFill({ stops, angle = 135 }: { stops: readonly GradientStop[]; angle?: number }) {
    const id = `f${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
    const v = gradientVector(angle);
    return (
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
            <Defs>
                <LinearGradient id={id} x1={v.x1} y1={v.y1} x2={v.x2} y2={v.y2}>
                    {stops.map((stop, i) => (
                        <Stop
                            key={i}
                            offset={stops.length > 1 ? i / (stops.length - 1) : 0}
                            stopColor={stop.color}
                            stopOpacity={stop.opacity ?? 1}
                        />
                    ))}
                </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill={`url(#${id})`} />
        </Svg>
    );
}

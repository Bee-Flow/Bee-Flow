/**
 * The web's gradient underline (`border-image: linear-gradient(90deg, …,
 * transparent)`) under a report or section title, and the gradient bar a
 * page card wears on top.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { GradientFill, type GradientStop } from './GradientFill';

function strip(height: number): ViewStyle {
    return { height, alignSelf: 'stretch' };
}

export function GradientRule({
    colors,
    height = 2,
    fadeOut = true,
}: {
    colors: readonly string[];
    height?: number;
    /** End in transparent, as the underline does; the card bar runs solid. */
    fadeOut?: boolean;
}) {
    const stops: GradientStop[] = colors.map((color) => ({ color }));
    if (fadeOut) stops.push({ color: colors[colors.length - 1] ?? '#000', opacity: 0 });
    return (
        <View style={strip(height)}>
            <GradientFill stops={stops} angle={90} />
        </View>
    );
}

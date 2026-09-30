/**
 * A placeholder bar shaped like the content it stands in for (ListSkeleton
 * stacks them into rows).
 *
 * Deliberately static: an animated shimmer on a list of twenty rows is a
 * continuous repaint, and on a mid-range Android phone that costs more frames
 * than the skeleton saves in perceived speed.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

export interface SkeletonProps {
    width?: number | `${number}%`;
    height?: number;
    /** Defaults to the theme's small radius. */
    radius?: number;
    style?: StyleProp<ViewStyle>;
}

export function Skeleton({ width = '100%', height = 16, radius, style }: SkeletonProps) {
    const theme = useTheme();
    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
                {
                    width,
                    height,
                    borderRadius: radius ?? theme.radii.sm,
                    backgroundColor: theme.colors.bgTertiary,
                },
                style,
            ]}
        />
    );
}

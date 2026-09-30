/**
 * The canvas's round "+": inserts a step at its target, on a line or where
 * nothing leaves a port yet.
 *
 * It keeps its size on the screen as the canvas zooms out (up to twice its
 * drawn size, as the web scales its edge buttons): at 60% a 26-unit button
 * was a 16dp target between two cards.
 */

import React from 'react';
import { Pressable } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useThemedStyles } from '@/core/theme/ThemeProvider';
import type { AddTarget } from '@/features/flow-editor/model/outline';
import { Icon } from '@/shared/ui';

import { useCanvasRuntime } from './CanvasRuntime';
import { makeCanvasStyles } from './canvasStyles';
import { HIT } from './overlay';

/** How much a canvas control grows against the zoom: 1 at 100% and closer, at most 2. */
export function counterScale(scale: number): number {
    'worklet';
    return scale >= 1 ? 1 : Math.min(2, 1 / Math.max(scale, 0.01));
}

export function PlusButton({ target, label, testID }: { target: AddTarget; label: string; testID: string }) {
    const styles = useThemedStyles(makeCanvasStyles);
    const { actions, scale } = useCanvasRuntime();
    const grow = useAnimatedStyle(() => ({ transform: [{ scale: counterScale(scale.get()) }] }));
    return (
        <Animated.View style={grow}>
            <Pressable
                onPress={() => actions.add(target)}
                hitSlop={HIT}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={styles.plus}
                testID={testID}
            >
                <Icon name="Plus" size={15} color={styles.plusGlyph.color} />
            </Pressable>
        </Animated.View>
    );
}

/**
 * Pinch to zoom, drag to look around, double-tap to zoom in or back out —
 * what a phone expects of a picture or a diagram opened full screen. The
 * transform lives in Reanimated shared values, so a gesture never re-renders
 * what it moves; the offset is held inside the content's own overhang, so a
 * zoomed picture cannot be dragged off the screen.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { clampOffset, clampScale, DOUBLE_TAP_SCALE } from './zoomMath';

const styles = StyleSheet.create({ fill: { flex: 1, alignSelf: 'stretch' } });
const MOVE = { duration: 200 };

export function ZoomView({ children }: { children: ReactNode }) {
    const scale = useSharedValue(1);
    const tx = useSharedValue(0);
    const ty = useSharedValue(0);
    const start = useSharedValue({ scale: 1, x: 0, y: 0 });
    const size = useSharedValue({ width: 0, height: 0 });

    const reset = () => {
        'worklet';
        scale.set(withTiming(1, MOVE));
        tx.set(withTiming(0, MOVE));
        ty.set(withTiming(0, MOVE));
    };
    const pinch = Gesture.Pinch()
        .onStart(() => start.set({ scale: scale.get(), x: tx.get(), y: ty.get() }))
        .onUpdate((e) => scale.set(clampScale(start.get().scale * e.scale)))
        .onEnd(() => {
            if (scale.get() <= 1) reset();
        });
    const pan = Gesture.Pan()
        .averageTouches(true)
        .onStart(() => start.set({ scale: scale.get(), x: tx.get(), y: ty.get() }))
        .onUpdate((e) => {
            const { width, height } = size.get();
            tx.set(clampOffset(start.get().x + e.translationX, width, scale.get()));
            ty.set(clampOffset(start.get().y + e.translationY, height, scale.get()));
        });
    const doubleTap = Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
            if (scale.get() > 1) reset();
            else scale.set(withTiming(DOUBLE_TAP_SCALE, MOVE));
        });

    const moved = useAnimatedStyle(() => ({
        transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: scale.get() }],
    }));

    return (
        <GestureDetector gesture={Gesture.Race(doubleTap, Gesture.Simultaneous(pan, pinch))}>
            <Animated.View
                style={[styles.fill, moved]}
                onLayout={(e) => size.set({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
            >
                {children}
            </Animated.View>
        </GestureDetector>
    );
}

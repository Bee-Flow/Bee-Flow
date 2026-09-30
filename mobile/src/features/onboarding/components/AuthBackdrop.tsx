/**
 * What sits behind a signed-out screen.
 *
 * The web login is not a flat page: it is a 160° gradient from --bg-primary
 * through --bg-secondary to --bg-tertiary with four slow-pulsing accent blobs
 * over it (agent-hub/src/pages/LoginPage.jsx). Reproducing it here is not
 * decoration for its own sake — the first screen of the app is the one that
 * says which product this is, and a flat `bgPrimary` fill reads as an
 * unfinished screen rather than as Bee Flow.
 *
 * Drawn in react-native-svg, which the app already ships (Charts, QrCode),
 * rather than pulling in expo-linear-gradient: a linear gradient package could
 * not draw the radial blobs anyway, so it would be a second native dependency
 * for half the job.
 *
 * The pulse is RN's own Animated on `opacity` with `useNativeDriver`, so it
 * runs on the UI thread and costs nothing on the JS thread while somebody is
 * typing a password. It stops entirely when the OS reports "reduce motion".
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    AccessibilityInfo,
    Animated,
    Easing,
    StyleSheet,
    useWindowDimensions,
    View,
} from 'react-native';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/core/theme/ThemeProvider';

/**
 * The four blobs, in the web's own terms: a fraction of the viewport for size
 * and position, the peak opacity, and the period of one breath. Ids are
 * namespaced because react-native-svg's gradient ids are global on Android.
 */
const BLOBS = [
    { id: 'a', size: 1.35, x: -0.1, y: -0.05, from: 'left', opacity: 0.07, period: 4000, delay: 0 },
    { id: 'b', size: 0.85, x: -0.05, y: 0.78, from: 'right', opacity: 0.05, period: 5000, delay: 1500 },
    { id: 'c', size: 0.5, x: 0.15, y: 0.6, from: 'left', opacity: 0.04, period: 6000, delay: 800 },
    { id: 'd', size: 0.34, x: 0.3, y: 0.15, from: 'right', opacity: 0.06, period: 7000, delay: 2000 },
] as const;

/** Android's "remove animations" setting, watched rather than read once. */
function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        let alive = true;
        void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
            if (alive) setReduced(value);
        });
        const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
        return () => {
            alive = false;
            sub.remove();
        };
    }, []);
    return reduced;
}

function Blob({
    spec,
    colour,
    width,
    height,
    animate,
}: {
    spec: (typeof BLOBS)[number];
    colour: string;
    width: number;
    height: number;
    animate: boolean;
}) {
    const size = width * spec.size;
    // Lazy initial state rather than a ref: the value has to survive a
    // re-render (a keystroke in the password field must not restart the loop),
    // and useState's initialiser is the one way to construct it once that the
    // React Compiler's rules allow to be read during render.
    const [progress] = useState(() => new Animated.Value(1));

    useEffect(() => {
        if (!animate) {
            progress.setValue(1);
            return;
        }
        const half = spec.period / 2;
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(progress, {
                    toValue: 0.5,
                    duration: half,
                    easing: Easing.inOut(Easing.ease),
                    useNativeDriver: true,
                }),
                Animated.timing(progress, {
                    toValue: 1,
                    duration: half,
                    easing: Easing.inOut(Easing.ease),
                    useNativeDriver: true,
                }),
            ]),
        );
        const timer = setTimeout(() => loop.start(), spec.delay);
        return () => {
            clearTimeout(timer);
            loop.stop();
        };
    }, [animate, progress, spec.delay, spec.period]);

    return (
        <Animated.View
            style={{
                position: 'absolute',
                width: size,
                height: size,
                top: height * spec.y,
                ...(spec.from === 'left' ? { left: width * spec.x } : { right: width * spec.x }),
                opacity: progress.interpolate({
                    inputRange: [0.5, 1],
                    outputRange: [spec.opacity / 2, spec.opacity],
                }),
            }}
        >
            {/* Sized in absolute units rather than percentages: react-native-svg
                resolves a percentage against the *viewBox*, and there is none
                here, so a "100%" root would collapse on some Android versions. */}
            <Svg width={size} height={size}>
                <Defs>
                    <RadialGradient id={`bf-auth-blob-${spec.id}`} cx="50%" cy="50%" r="50%">
                        <Stop offset="0" stopColor={colour} stopOpacity="1" />
                        {/* transparent at 70%, exactly as the web's
                            `radial-gradient(circle, c, transparent 70%)`. */}
                        <Stop offset="0.7" stopColor={colour} stopOpacity="0" />
                    </RadialGradient>
                </Defs>
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={size / 2}
                    fill={`url(#bf-auth-blob-${spec.id})`}
                />
            </Svg>
        </Animated.View>
    );
}

export function AuthBackdrop() {
    const theme = useTheme();
    const { width, height } = useWindowDimensions();
    const reduced = useReducedMotion();

    const { bgPrimary, bgSecondary, bgTertiary, accentPrimary, accentSecondary, glass } =
        theme.colors;

    // 160deg in CSS points down and slightly right: the gradient's direction
    // vector is (sin160°, -cos160°) ≈ (0.34, 0.94), which is what the SVG
    // start/end points below describe in the box's own coordinates.
    const base = useMemo(
        () => (
            <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
                <Defs>
                    <LinearGradient id="bf-auth-base" x1="0" y1="0" x2="0.34" y2="0.94">
                        <Stop offset="0" stopColor={bgPrimary} />
                        <Stop offset="0.5" stopColor={bgSecondary} />
                        <Stop offset="1" stopColor={bgTertiary} />
                    </LinearGradient>
                </Defs>
                <Rect x={0} y={0} width={width} height={height} fill="url(#bf-auth-base)" />
            </Svg>
        ),
        [bgPrimary, bgSecondary, bgTertiary, width, height],
    );

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {/* A glass theme's bgPrimary is literally `transparent`, and an SVG
                stop of "transparent" resolves to transparent BLACK — a dark
                smear over the blur that is the whole point of those themes. So
                the gradient is skipped and the blobs float on the blur. */}
            {glass ? null : base}
            {BLOBS.map((spec) => (
                <Blob
                    key={spec.id}
                    spec={spec}
                    colour={spec.id === 'a' || spec.id === 'c' ? accentPrimary : accentSecondary}
                    width={width}
                    height={height}
                    animate={!reduced}
                />
            ))}
        </View>
    );
}

/**
 * The frame every screen sits in.
 *
 * Bundles the four things that otherwise get forgotten in exactly one screen
 * out of thirty and look like a rendering bug:
 *
 *   - The themed background. RN views default to transparent, and a
 *     transparent root over the OS's white window is a white flash on a dark
 *     theme.
 *   - Safe-area insets. The app is edge-to-edge (required on Android 15), so
 *     the status bar and gesture bar overlap content unless something pads it.
 *   - Keyboard avoidance. On Android the window resizes, but a screen with a
 *     bottom-anchored composer still needs to know how much room is left.
 *   - An optional full-bleed backdrop, painted under the safe-area insets —
 *     the onboarding screens use it for the gradient the web login has.
 */

import React, { type ReactNode } from 'react';
import {
    KeyboardAvoidingView,
    Platform,
    StyleSheet,
    View,
    type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '../theme/ThemeProvider';

export interface ScreenProps {
    children: ReactNode;
    /**
     * Which edges to inset. A screen with its own header usually wants
     * ['bottom'] only, because the header paints under the status bar itself.
     */
    edges?: readonly Edge[];
    /** Adds the standard horizontal gutter. Lists that bleed set this false. */
    padded?: boolean;
    /** Lifts content above the keyboard. On for anything with a text input. */
    avoidKeyboard?: boolean;
    style?: ViewStyle;
    /** Paints bgSecondary instead of bgPrimary — for settings-style screens. */
    inset?: boolean;
    /**
     * Painted edge to edge BEHIND the content, under the safe-area insets.
     *
     * A screen cannot do this itself: the flat background below is on the
     * outermost view, so anything a screen renders as its first child is
     * already on top of it and stops at the insets. The onboarding screens use
     * it for the gradient the web login has (features/onboarding/AuthBackdrop).
     */
    backdrop?: ReactNode;
}

export function Screen({
    children,
    edges = ['top', 'bottom'],
    padded = false,
    avoidKeyboard = false,
    inset = false,
    backdrop,
    style,
}: ScreenProps) {
    const theme = useTheme();
    const background = inset ? theme.colors.bgSecondary : theme.colors.bgPrimary;

    const content = (
        <SafeAreaView
            edges={edges}
            style={[
                styles.flex,
                // A screen with its own backdrop must not paint over it.
                { backgroundColor: backdrop ? 'transparent' : background },
                padded ? { paddingHorizontal: theme.spacing.lg } : null,
                style,
            ]}
        >
            {children}
        </SafeAreaView>
    );

    const body = avoidKeyboard ? (
        <KeyboardAvoidingView
            style={styles.flex}
            // Android resizes the window (softwareKeyboardLayoutMode: 'pan' in
            // app.config.ts keeps the composer visible), so 'height' is the
            // behaviour that matches what the OS is already doing.
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            {content}
        </KeyboardAvoidingView>
    ) : (
        content
    );

    return (
        <View style={[styles.flex, { backgroundColor: background }]}>
            {backdrop}
            {body}
        </View>
    );
}

/**
 * Bottom padding that clears the gesture bar without double-counting a
 * SafeAreaView that already inset it. Used by floating composers and FABs,
 * which sit outside the safe area on purpose.
 */
export function useBottomInset(extra = 0): number {
    return useSafeAreaInsets().bottom + extra;
}

const styles = StyleSheet.create({
    flex: { flex: 1 },
});

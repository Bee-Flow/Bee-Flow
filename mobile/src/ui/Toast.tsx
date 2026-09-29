/**
 * Transient confirmations.
 *
 * Deliberately minimal and deliberately NOT the app's error channel. A toast
 * that carries the only copy of an error message is a message the user cannot
 * re-read, cannot copy and cannot act on — errors belong inline, next to the
 * thing that failed (see Feedback.tsx). Toasts are for "Copied", "Saved",
 * "Automation queued": facts the user already expected.
 */

import * as Haptics from 'expo-haptics';
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from './Text';
import { useTheme } from '../theme/ThemeProvider';


type ToastTone = 'neutral' | 'success' | 'error';

interface ToastMessage {
    id: number;
    text: string;
    tone: ToastTone;
}

interface ToastContextValue {
    toast: (text: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VISIBLE_MS = 2400;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [message, setMessage] = useState<ToastMessage | null>(null);
    const nextId = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const toast = useCallback((text: string, tone: ToastTone = 'neutral') => {
        if (timer.current) clearTimeout(timer.current);
        nextId.current += 1;
        setMessage({ id: nextId.current, text, tone });
        if (tone === 'success') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (tone === 'error') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        timer.current = setTimeout(() => setMessage(null), VISIBLE_MS);
    }, []);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    const value = useMemo(() => ({ toast }), [toast]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            {message ? <ToastView key={message.id} message={message} /> : null}
        </ToastContext.Provider>
    );
}

function ToastView({ message }: { message: ToastMessage }) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    // useState, not useRef: an Animated.Value read during render is exactly
    // what react-hooks/refs flags, and the lazy initialiser gives the same
    // "create once" behaviour without touching a ref's .current while
    // rendering.
    const [anim] = useState(() => new Animated.Value(0));

    useEffect(() => {
        Animated.timing(anim, {
            toValue: 1,
            duration: theme.motion.base,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        }).start();
    }, [anim, theme.motion.base]);

    const border = {
        neutral: theme.colors.borderDefault,
        success: theme.colors.success,
        error: theme.colors.error,
    }[message.tone];

    return (
        <Animated.View
            pointerEvents="none"
            accessibilityLiveRegion="polite"
            style={[
                styles.wrap,
                {
                    // Above the tab bar, not over it — a toast that covers the
                    // navigation is a toast that blocks the escape route.
                    bottom: insets.bottom + 72,
                    opacity: anim,
                    transform: [
                        { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
                    ],
                },
            ]}
        >
            <View
                style={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radii.pill,
                    backgroundColor: theme.colors.bgTertiary,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: border,
                    ...theme.elevation.popover,
                }}
            >
                <Text variant="caption" numberOfLines={2}>
                    {message.text}
                </Text>
            </View>
        </Animated.View>
    );
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
    return ctx;
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 24 },
});

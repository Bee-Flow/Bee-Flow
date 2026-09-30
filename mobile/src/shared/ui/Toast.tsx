/**
 * Transient confirmations.
 *
 * Deliberately minimal and deliberately NOT the app's error channel. A toast
 * that carries the only copy of an error message is a message the user cannot
 * re-read, cannot copy and cannot act on — errors belong inline, next to the
 * thing that failed (see ErrorState and Banner). Toasts are for "Copied", "Saved",
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
import { Animated, Easing, View, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon, type IconName } from './icons/Icon';
import { Text } from './Text';
import { tint } from './tint';


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

/** The web Toaster's kinds: `neutral` is its `info`. */
const TOAST_ICON: Record<ToastTone, IconName> = { neutral: 'Info', success: 'Check', error: 'CircleAlert' };

function ToastView({ message }: { message: ToastMessage }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
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

    return (
        <Animated.View
            pointerEvents="none"
            accessibilityLiveRegion="polite"
            style={[
                styles.wrap,
                // Above the tab bar, not over it — a toast that covers the
                // navigation is a toast that blocks the escape route.
                { bottom: insets.bottom + 72, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] },
            ]}
        >
            {/* The web's toast: a card with a default border, a popover shadow
                and the kind in a 20px tinted circle before the words. */}
            <View style={styles.toast}>
                <View style={[styles.mark, styles.markTone[message.tone]]}>
                    <Icon name={TOAST_ICON[message.tone]} size={12} color={styles.glyph[message.tone]} strokeWidth={2.25} />
                </View>
                <Text variant="caption" style={styles.text} numberOfLines={3}>
                    {message.text}
                </Text>
            </View>
        </Animated.View>
    );
}

const TOAST_TONES: readonly ToastTone[] = ['neutral', 'success', 'error'];

/** A kind's colour: the web Toaster's success/error/info set, from the theme. */
function toastColor(theme: Theme, tone: ToastTone): string {
    if (tone === 'success') return theme.colors.success;
    if (tone === 'error') return theme.colors.error;
    return theme.colors.info;
}

const makeStyles = (theme: Theme) => ({
    wrap: {
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'center',
        paddingHorizontal: theme.spacing.lg,
    } satisfies ViewStyle,
    toast: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing[2],
        minWidth: 220,
        maxWidth: 480,
        paddingHorizontal: theme.spacing[3],
        paddingVertical: theme.spacing[2.5],
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard,
        boxShadow: theme.shadows.popover,
    } satisfies ViewStyle,
    mark: {
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    } satisfies ViewStyle,
    markTone: Object.fromEntries(
        TOAST_TONES.map((tone) => [tone, { backgroundColor: tint(toastColor(theme, tone), 12) }]),
    ) as Record<ToastTone, ViewStyle>,
    glyph: Object.fromEntries(TOAST_TONES.map((tone) => [tone, toastColor(theme, tone)])) as Record<ToastTone, string>,
    text: { flexShrink: 1, paddingTop: 1 } satisfies TextStyle,
});

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
    return ctx;
}


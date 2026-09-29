/**
 * The screen a person sees instead of nothing.
 *
 * A React render error in a release build unmounts the entire tree: Android
 * shows a blank window, the app appears frozen, and force-quitting is the only
 * way out. Everyone who hit that had the same experience — "it just closed" —
 * and reported it that way, which is not a report anyone can act on.
 *
 * So: a boundary at the root, a screen that says what happened, a way back in,
 * and a report on its way to the server. The `label` prop exists so a nested
 * boundary can name the part it protects; the root one is 'root'.
 *
 * Two things this file does NOT do, both on purpose:
 *
 *   - It does not use the theme, the typography scale or the shared `Text` and
 *     `Button` components. All three read React context, and a crash inside
 *     ThemeProvider would then crash the screen whose job is to survive the
 *     crash. `useColorScheme` is a native hook with no provider above it, which
 *     is enough to avoid showing a white slab to someone in dark mode. Its
 *     words come from `translate()` rather than `useTranslation()` for the
 *     same reason: a plain read of a module-level object, no hook, nothing
 *     above it to fail.
 *   - It does not show the stack to the user in a release build. A stack trace
 *     is not information a person can act on, and after scrubbing it is not
 *     information they can pass on either. In development it is shown, because
 *     there the reader is the developer.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { reportClientError } from './report';
import { translate } from '../i18n';
import { PALETTES } from '../theme/tokens';

interface Props {
    children: React.ReactNode;
    /** Names the region for the crash report: 'root', 'chat', 'automations'. */
    label?: string;
    /** Rendered instead of the default screen. Gets a reset callback. */
    fallback?: (reset: () => void) => React.ReactNode;
}

interface State {
    error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
    override state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
        void reportClientError({
            label: `error-boundary:${this.props.label ?? 'root'}`,
            message: error.message,
            stack: error.stack,
            componentStack: info.componentStack ?? undefined,
        });
    }

    reset = (): void => {
        this.setState({ error: null });
    };

    override render(): React.ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;
        if (this.props.fallback) return this.props.fallback(this.reset);
        return <CrashScreen error={error} onRetry={this.reset} />;
    }
}

function CrashScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
    const scheme = useColorScheme();
    const palette = scheme === 'light' ? PALETTES.light : PALETTES.dark;

    return (
        <View style={[styles.screen, { backgroundColor: palette.bgPrimary }]}>
            <ScrollView contentContainerStyle={styles.body}>
                <Text style={[styles.title, { color: palette.textPrimary }]}>
                    {translate('mobile.crash.title', 'This screen stopped working')}
                </Text>
                <Text style={[styles.message, { color: palette.textSecondary }]}>
                    {translate(
                        'mobile.crash.message',
                        'Something in the app failed, not something you did. A report has been ' +
                            'sent to your Bee Flow server so it can be fixed — it contains what ' +
                            'went wrong, not what you were working on.',
                    )}
                </Text>

                {__DEV__ ? (
                    <Text style={[styles.detail, { color: palette.textMuted }]} selectable>
                        {error.message}
                        {error.stack ? `\n\n${error.stack}` : ''}
                    </Text>
                ) : null}

                <Pressable
                    onPress={onRetry}
                    accessibilityRole="button"
                    accessibilityLabel={translate('mobile.error.retry', 'Try again')}
                    style={({ pressed }) => [
                        styles.button,
                        {
                            backgroundColor: palette.accentPrimary,
                            opacity: pressed ? 0.85 : 1,
                        },
                    ]}
                >
                    <Text style={[styles.buttonLabel, { color: palette.accentPrimaryFg }]}>
                        {translate('mobile.error.retry', 'Try again')}
                    </Text>
                </Pressable>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 },
    body: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 16 },
    title: { fontSize: 22, fontWeight: '700' },
    message: { fontSize: 15, lineHeight: 22 },
    detail: { fontSize: 12, lineHeight: 17, fontFamily: 'monospace' },
    // 48 is the app's minimum touch target; the crash screen is the last place
    // to make someone aim.
    button: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    buttonLabel: { fontSize: 16, fontWeight: '600' },
});

/**
 * The frame every signed-out screen sits in.
 *
 * AppHeader is for tab roots — it carries global search and the notification
 * bell, neither of which exists before you are signed in — so the onboarding
 * routes need their own top. This is deliberately not a header at all: a
 * signed-out screen has one job, and centring that job on the page says so
 * better than a title bar with nothing in it.
 *
 * The shape is the web login's, deliberately (agent-hub/src/pages/LoginPage.jsx):
 * a gradient backdrop with slow accent blobs, and the content in one centred
 * card with the Bee Flow mark at its head. This is the first screen anybody
 * sees, and it has to be recognisably the same product as the browser tab
 * their colleague is using — a flat dark page with a generic glyph is not.
 *
 * The mark defaults to the logo, again as the web does on every one of these
 * steps. A screen passes `icon` only when the glyph carries meaning the logo
 * cannot — "Two-factor is on", "That connection is not encrypted".
 *
 * The content is a ScrollView because these screens grow: a login form with an
 * error, three SSO buttons and a sign-up link is taller than a short phone in
 * landscape with a keyboard up. `keyboardShouldPersistTaps` matters more than
 * it looks — without it the first tap on "Sign in" only dismisses the keyboard
 * and the user has to press twice.
 */

import React, { type ReactNode } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BrandMark, Icon, Screen, Text, type IconName } from '@/shared/ui';

import { AuthBackdrop } from './AuthBackdrop';

export interface AuthShellProps {
    /**
     * Icon for the round mark above the title. Omitted on the ordinary
     * steps, which show the Bee Flow logo instead; set it only where the glyph
     * says something the logo cannot.
     */
    icon?: IconName;
    /** Tints the mark. `warning` and `error` are for dead ends, not for forms. */
    tone?: 'accent' | 'success' | 'warning' | 'error';
    title: string;
    /** One or two plain sentences. Never a paragraph. */
    subtitle?: string;
    children: ReactNode;
    /** Pinned under the content — "change server", "sign out", small print. */
    footer?: ReactNode;
}

export function AuthShell({
    icon,
    tone = 'accent',
    title,
    subtitle,
    children,
    footer,
}: AuthShellProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const colour = {
        accent: theme.colors.accentPrimary,
        success: theme.colors.success,
        warning: theme.colors.warning,
        error: theme.colors.error,
    }[tone];

    return (
        <Screen edges={['top', 'bottom']} padded avoidKeyboard backdrop={<AuthBackdrop />}>
            <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                contentContainerStyle={styles.scroll}
            >
                <View style={styles.card}>
                    {/* The web's glass highlight: a hairline that fades in from
                        both ends along the card's top edge. Inset rather than
                        full-width, or it reads as a border. */}
                    <View style={styles.highlight} />

                    <View style={styles.head}>
                        {icon ? (
                            <View testID="auth-shell-icon" style={[styles.iconTile, styles[tone]]}>
                                <Icon name={icon} size={26} color={colour} />
                            </View>
                        ) : (
                            <View testID="auth-shell-logo" style={styles.logoDisc}>
                                {/* Decorative: the title below is the header a
                                    screen reader announces, so a second
                                    "Bee Flow" here would just be noise. */}
                                <BrandMark size={60} decorative />
                            </View>
                        )}
                        {/* The title is the screen's live region: when a stage
                            changes under the user, this is the sentence that has
                            to reach a screen reader. */}
                        <Text variant="heading" center accessibilityRole="header">
                            {title}
                        </Text>
                        {subtitle ? (
                            <Text variant="caption" tone="secondary" center>
                                {subtitle}
                            </Text>
                        ) : null}
                    </View>

                    <View style={styles.body}>{children}</View>

                    {footer ? <View style={styles.footer}>{footer}</View> : null}
                </View>
            </ScrollView>
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    scroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.spacing.xl } satisfies ViewStyle,
    card: {
        backgroundColor: theme.colors.bgSecondary,
        borderRadius: theme.radii.xl,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        padding: theme.spacing.xl,
        gap: theme.spacing.xl,
        overflow: 'hidden',
        ...theme.elevation.popover,
    } satisfies ViewStyle,
    highlight: {
        position: 'absolute',
        top: 0,
        left: theme.spacing.xxl,
        right: theme.spacing.xxl,
        height: 1,
        backgroundColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    head: { alignItems: 'center', gap: theme.spacing.md } satisfies ViewStyle,
    iconTile: {
        width: 64,
        height: 64,
        borderRadius: theme.radii.lg,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.bgPrimary,
        borderWidth: 1,
    } satisfies ViewStyle,
    accent: { borderColor: theme.colors.accentPrimary } satisfies ViewStyle,
    success: { borderColor: theme.colors.success } satisfies ViewStyle,
    warning: { borderColor: theme.colors.warning } satisfies ViewStyle,
    error: { borderColor: theme.colors.error } satisfies ViewStyle,
    // The web's ring-4 around its logo, on the theme's own ground rather than
    // a fixed black: the bee is drawn in the theme's ink, so the disc only has
    // to lift it off the card.
    logoDisc: {
        width: 96,
        height: 96,
        borderRadius: 48,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.bgPrimary,
        borderWidth: 4,
        borderColor: theme.colors.borderSubtle,
        ...theme.elevation.raised,
    } satisfies ViewStyle,
    body: { gap: theme.spacing.lg } satisfies ViewStyle,
    footer: { gap: theme.spacing.sm, alignItems: 'center' } satisfies ViewStyle,
});

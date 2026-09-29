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

import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React, { type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { AuthBackdrop } from './AuthBackdrop';
import { useTheme } from '../../theme/ThemeProvider';
import { Screen } from '../../ui/Screen';
import { Text } from '../../ui/Text';

const LOGO = require('../../../assets/icon.png');

/**
 * The disc behind the logo is a fixed near-black in every theme, because the
 * mark itself is drawn on that field — putting it on a light surface would
 * show a dark square with rounded corners rather than a logo. It is the same
 * choice the web makes by using `object-cover` on an image with its own
 * background.
 */
const LOGO_FIELD = '#0f0f13';

export interface AuthShellProps {
    /**
     * Feather glyph for the round mark above the title. Omitted on the ordinary
     * steps, which show the Bee Flow logo instead; set it only where the glyph
     * says something the logo cannot.
     */
    icon?: keyof typeof Feather.glyphMap;
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
                contentContainerStyle={{
                    flexGrow: 1,
                    justifyContent: 'center',
                    paddingVertical: theme.spacing.xl,
                }}
            >
                <View
                    style={{
                        backgroundColor: theme.colors.bgSecondary,
                        borderRadius: theme.radii.xl,
                        borderWidth: 1,
                        borderColor: theme.colors.borderSubtle,
                        padding: theme.spacing.xl,
                        gap: theme.spacing.xl,
                        overflow: 'hidden',
                        ...theme.elevation.popover,
                    }}
                >
                    {/* The web's glass highlight: a hairline that fades in from
                        both ends along the card's top edge. Inset rather than
                        full-width, or it reads as a border. */}
                    <View
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: theme.spacing.xxl,
                            right: theme.spacing.xxl,
                            height: 1,
                            backgroundColor: theme.colors.borderDefault,
                        }}
                    />

                    <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
                        {icon ? (
                            <View
                                testID="auth-shell-icon"
                                style={{
                                    width: 64,
                                    height: 64,
                                    borderRadius: theme.radii.lg,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: theme.colors.bgPrimary,
                                    borderWidth: 1,
                                    borderColor: colour,
                                }}
                            >
                                <Feather name={icon} size={26} color={colour} />
                            </View>
                        ) : (
                            <View
                                testID="auth-shell-logo"
                                style={{
                                    width: 112,
                                    height: 112,
                                    borderRadius: 56,
                                    overflow: 'hidden',
                                    backgroundColor: LOGO_FIELD,
                                    // The web's ring-4: a soft halo that lifts
                                    // the mark off the card without drawing a
                                    // hard circle around it.
                                    borderWidth: 4,
                                    borderColor: theme.colors.borderSubtle,
                                    ...theme.elevation.raised,
                                }}
                            >
                                <Image
                                    source={LOGO}
                                    // Decorative: the title below is the header
                                    // a screen reader announces, so a second
                                    // "Bee Flow" here would just be noise.
                                    accessibilityElementsHidden
                                    importantForAccessibility="no-hide-descendants"
                                    contentFit="cover"
                                    style={{ width: '100%', height: '100%' }}
                                />
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

                    <View style={{ gap: theme.spacing.lg }}>{children}</View>

                    {footer ? (
                        <View style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                            {footer}
                        </View>
                    ) : null}
                </View>
            </ScrollView>
        </Screen>
    );
}

/**
 * A quiet, full-width text action — "Forgot your password?", "Use a recovery
 * code", "Sign out". A Button with variant="ghost" is the same thing, but
 * these read as prose rather than as controls, and stacking four ghost buttons
 * makes a screen look like a keypad.
 */
export function TextLink({
    label,
    onPress,
    tone = 'accent',
    disabled = false,
    accessibilityHint,
}: {
    label: string;
    onPress: () => void;
    tone?: 'accent' | 'tertiary' | 'error';
    disabled?: boolean;
    accessibilityHint?: string;
}) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => ({
                // Full 48dp of touch, without 48dp of visible whitespace.
                minHeight: theme.minTouch,
                justifyContent: 'center',
                borderRadius: theme.radii.md,
                opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
            })}
        >
            <Text
                variant="body"
                tone={tone === 'accent' ? 'accent' : tone === 'error' ? 'error' : 'tertiary'}
                center
                weight="medium"
            >
                {label}
            </Text>
        </Pressable>
    );
}

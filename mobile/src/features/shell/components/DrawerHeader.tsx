/**
 * The drawer's top bar — the web Sidebar's: the logo (tapping it starts a new
 * chat, as on the web), and the notification bell.
 *
 * The web's white-label rule, exactly: a SELF-HOSTED installation whose
 * organisation uploaded a logo shows that logo, with "Powered by Bee Flow"
 * under it; everyone else sees the Bee Flow mark. Cloud is unchanged on the
 * web, so it is unchanged here.
 *
 * Where the phone differs on purpose: the web draws a 72px image with its own
 * black field, which on a phone was a heavy black square on the Day theme and
 * a black square on a near-black drawer on Night. Here the bee is drawn
 * without a field (BrandMark, one ink per theme) at the bell's height, so the
 * bar reads as one row. An org's logo keeps a tile, but one in the theme's
 * own card colour, because an uploaded logo may bring any background.
 */

import { Image } from 'expo-image';
import React from 'react';
import { Pressable, StyleSheet, View, type ImageStyle, type ViewStyle } from 'react-native';

import { useAccess } from '@/core/access';
import { apiUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { NotificationBell } from '@/features/notifications';
import { BrandMark, Text } from '@/shared/ui';

import { useDrawerActions } from '../hooks/drawerActions';

/** The org's logo as a URL, or null: a server-relative path is resolved against the server. */
function logoSource(logo: string | null | undefined): string | null {
    if (!logo) return null;
    if (logo.startsWith('http') || logo.startsWith('data:')) return logo;
    try {
        return apiUrl(logo);
    } catch {
        return null;
    }
}

export function DrawerHeader() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const access = useAccess();
    const { go } = useDrawerActions();
    const orgLogo = access.mode === 'self-hosted' ? logoSource(access.organization?.logo) : null;
    const orgName = access.organization?.name || t('mobile.nav.organisation_logo', 'Organisation');
    return (
        <View style={styles.wrap}>
            <View style={styles.bar}>
                <Pressable
                    onPress={() => go('/')}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.new_chat', 'New Chat')}
                    style={({ pressed }) => [
                        styles.logoTarget,
                        orgLogo ? styles.orgTile : null,
                        pressed ? styles.pressed : null,
                    ]}
                    testID="drawer-logo"
                >
                    {orgLogo ? (
                        <Image
                            source={{ uri: orgLogo }}
                            accessibilityLabel={orgName}
                            style={styles.logo}
                            contentFit="contain"
                        />
                    ) : (
                        <BrandMark size={40} />
                    )}
                </Pressable>
                <NotificationBell />
            </View>
            {orgLogo ? (
                <Text variant="label" tone="tertiary" style={styles.powered}>
                    {t('sidebar.powered_by', 'Powered by Bee Flow')}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    wrap: { paddingHorizontal: theme.spacing[3], paddingTop: theme.spacing[3] } satisfies ViewStyle,
    bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } satisfies ViewStyle,
    // A 48dp touch target, the bell's size, so the logo and the bell share a line.
    logoTarget: {
        width: theme.minTouch,
        height: theme.minTouch,
        borderRadius: theme.radii.md,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
    } satisfies ViewStyle,
    orgTile: {
        backgroundColor: theme.colors.bgCard,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.cardBorder,
        padding: theme.spacing.xs,
    } satisfies ViewStyle,
    pressed: { opacity: 0.7 } satisfies ViewStyle,
    logo: { width: '100%', height: '100%' } satisfies ImageStyle,
    powered: { marginTop: theme.spacing[1] },
});

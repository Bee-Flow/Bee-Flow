/**
 * The drawer's footer — the web SidebarFooter: your avatar (the emoji you
 * chose on a tertiary disc, your picture, or else the accent disc with a
 * person glyph — never initials, which the web does not draw here) and name,
 * which open the profile menu. Settings; Organisation for an organisation
 * administrator (the server's org-admin predicate, useIsOrgAdmin); the whole
 * map of the app; and Sign out, set apart and confirmed.
 *
 * No "Admin dashboard" here for anyone: the web's super-admin dashboard is
 * out of the phone's scope, and the operator's health screen stays one row
 * down in Settings.
 */

import React, { useState } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useIsOrgAdmin } from '@/core/access';
import { useAuth } from '@/core/auth/AuthProvider';
import type { User } from '@/core/auth/types';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { ActionMenu, Avatar, Icon, Text, type ActionMenuItem } from '@/shared/ui';

import { useDrawerActions } from '../hooks/drawerActions';

/** SidebarFooter's avatar, at its 32px. */
function FooterAvatar({ user, name }: { user: User | null; name: string }) {
    const styles = useThemedStyles(makeStyles);
    const avatar = user?.avatar || null;
    if (avatar && user?.avatarType === 'emoji') {
        return (
            <View style={[styles.disc, styles.emojiDisc]}>
                <Text style={styles.emoji} allowFontScaling={false} accessibilityElementsHidden>
                    {avatar}
                </Text>
            </View>
        );
    }
    if (avatar && (user?.avatarType === 'image' || user?.avatarType === 'url')) {
        return <Avatar name={name} uri={avatar} size={32} />;
    }
    return (
        <View style={[styles.disc, styles.accentDisc]}>
            <Icon name="User" size={16} color={styles.onAccent.color} />
        </View>
    );
}

export function ProfileFooter() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const confirm = useConfirm();
    const { user, signOut } = useAuth();
    const orgAdmin = useIsOrgAdmin();
    const { push, close } = useDrawerActions();
    const [open, setOpen] = useState(false);
    const name = user?.displayName || user?.id || t('mobile.nav.you', 'You');

    const leave = async () => {
        const ok = await confirm({
            title: t('mobile.nav.sign_out_title', 'Sign out?'),
            message: t('mobile.nav.sign_out_message', 'Your encryption key is removed from this device. Anything you have not sent is lost.'),
            confirmLabel: t('sidebar.sign_out', 'Sign Out'),
        });
        if (ok) {
            close();
            void signOut();
        }
    };

    const items: ActionMenuItem[] = [
        { id: 'settings', label: t('sidebar.settings', 'Settings'), icon: 'Settings', onPress: () => push('/settings') },
        ...(orgAdmin
            ? [{ id: 'org', label: t('settings.organisation', 'Organisation'), icon: 'Briefcase' as const, onPress: () => push('/org') }]
            : []),
        { id: 'sitemap', label: t('mobile.sitemap.title', 'Everything Bee Flow does'), icon: 'Compass', onPress: () => push('/sitemap') },
        { id: 'sign-out', label: t('sidebar.sign_out', 'Sign Out'), icon: 'LogOut', destructive: true, onPress: () => void leave() },
    ];

    return (
        <>
            <Pressable
                onPress={() => setOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityHint={t('mobile.nav.profile_menu', 'Opens settings and sign out')}
                accessibilityState={{ expanded: open }}
                style={({ pressed }) => [styles.row, pressed || open ? styles.pressed : null]}
                testID="drawer-profile"
            >
                <FooterAvatar user={user} name={name} />
                <Text variant="caption" weight="medium" style={styles.name} numberOfLines={1}>
                    {name}
                </Text>
                <Icon name="ChevronUp" size={16} color={theme.colors.textTertiary} />
            </Pressable>
            <ActionMenu visible={open} onClose={() => setOpen(false)} title={name} items={items} testID="profile-menu" />
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2.5],
        minHeight: 56,
        paddingHorizontal: theme.spacing[4],
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    name: { flex: 1, color: theme.colors.textPrimary } satisfies TextStyle,
    disc: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' } satisfies ViewStyle,
    emojiDisc: { backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    // text-base: the emoji at 16, whatever the system font scale.
    emoji: { fontSize: 16, lineHeight: 20 } satisfies TextStyle,
    // linear-gradient(135deg, accent-primary, accent-primary-hover), the
    // accent alone where the platform draws no gradient.
    accentDisc: {
        backgroundColor: theme.colors.accentPrimary,
        experimental_backgroundImage: `linear-gradient(135deg, ${theme.colors.accentPrimary}, ${theme.colors.accentPrimaryHover})`,
    } satisfies ViewStyle,
    onAccent: { color: theme.colors.accentPrimaryFg },
});

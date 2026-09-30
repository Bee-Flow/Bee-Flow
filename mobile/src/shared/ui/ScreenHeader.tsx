/**
 * The header. Singular: one treatment of the top 56dp for every screen.
 *
 * There used to be four (this, an AppHeader for tab roots, sixteen hand-rolled
 * back-arrow rows, and the chat screen's own), so the back arrow moved and the
 * title changed size as you navigated. Size is a prop, not a component:
 * `large` is the tab-root treatment, everything pushed uses the default.
 *
 * Search and the bell sit on every header, not just the tab roots — both are
 * things you reach for FROM wherever you are. The root supplies them through
 * HeaderAccessoryProvider (headerAccessories.tsx), because the bell needs an
 * API call this kit may not make.
 *
 * `onPressTitle` exists for the chat screen, whose title opens the
 * conversation's details — the only place with room for it.
 *
 * A screen inside the navigation drawer (the tab roots) shows the drawer
 * toggle where a pushed screen shows Back, like the web's mobile header; the
 * drawer layout supplies it through HeaderMenuProvider (headerMenu.tsx).
 */

import { useRouter } from 'expo-router';
import React, { type ReactNode } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { useHeaderAccessories, type HeaderAccessory } from './headerAccessories';
import { useHeaderMenu } from './headerMenu';
import { IconButton } from './IconButton';
import { Icon } from './icons/Icon';
import { Text } from './Text';

export interface ScreenHeaderProps {
    title: string;
    subtitle?: string;
    /** This screen's own actions, placed before search and the bell. */
    actions?: ReactNode;
    /** Rendered before the title (after the drawer toggle or Back). */
    leading?: ReactNode;
    /**
     * `large` is the tab-root treatment: a bigger title, a wider gutter, and
     * no back button. Everything pushed uses the default.
     */
    size?: 'default' | 'large';
    /** Defaults to router.back(); override for a screen with a custom escape. */
    onBack?: () => void;
    /**
     * Back on (true) or off (false). By default a pushed screen has it, and a
     * large header or a screen inside the drawer (which gets the drawer
     * toggle instead) does not.
     */
    showBack?: boolean;
    /** Makes the title block a button — see `titleHint`. */
    onPressTitle?: () => void;
    /**
     * What tapping the title does. Required in spirit whenever `onPressTitle`
     * is given: a tappable heading that does not say so is a secret.
     */
    titleHint?: string;
    /**
     * Turns off the global accessories (search and the bell, supplied by
     * HeaderAccessoryProvider) — for a screen that IS one of them.
     */
    global?: boolean;
    /**
     * A control centred in place of the title (a mode switch, say).
     *
     * Replaces the title rather than joining it: a tab root's title repeats the
     * label already lit in the tab bar two inches below, so the centre of the
     * header is free for a control that switches what the screen shows.
     */
    center?: ReactNode;
}

export function ScreenHeader({
    title,
    subtitle,
    actions,
    leading,
    size = 'default',
    onBack,
    showBack,
    onPressTitle,
    titleHint,
    global: showGlobal = true,
    center,
}: ScreenHeaderProps) {
    const styles = useThemedStyles(makeStyles);
    const large = size === 'large';
    const menu = useHeaderMenu();
    // A large header is a tab root, which is never pushed and has nothing to
    // go back to; neither has any screen inside the drawer.
    const back = showBack ?? (!large && !menu);
    const accessories = useHeaderAccessories();
    const shown = showGlobal ? accessories : NO_ACCESSORIES;
    // A centred control beside the drawer toggle and nothing on the right:
    // balance the toggle, or the control sits 24dp off centre.
    const balance = Boolean(center && menu && !back && !actions && shown.length === 0);

    return (
        <View style={[styles.bar, back || menu ? styles.barBack : null]}>
            <HeaderStart back={back} onBack={onBack} />
            {leading}
            <HeaderTitle
                title={title}
                subtitle={subtitle}
                large={large}
                center={center}
                onPressTitle={onPressTitle}
                titleHint={titleHint}
            />
            {actions}
            {shown.map((Accessory, index) => (
                <Accessory key={index} />
            ))}
            {balance ? <View style={styles.balance} /> : null}
        </View>
    );
}

const NO_ACCESSORIES: readonly HeaderAccessory[] = [];

/** Back on a pushed screen; the drawer toggle on a screen inside the drawer. */
function HeaderStart({ back, onBack }: { back: boolean; onBack?: () => void }) {
    const theme = useTheme();
    const t = useTranslation();
    const router = useRouter();
    const menu = useHeaderMenu();
    if (back) {
        return (
            <IconButton
                icon={<Icon name="ArrowLeft" size={20} color={theme.colors.textPrimary} />}
                accessibilityLabel={t('common.back', 'Back')}
                onPress={onBack ?? (() => router.back())}
            />
        );
    }
    if (!menu) return null;
    return (
        <IconButton
            icon={<Icon name="Menu" size={20} color={theme.colors.textPrimary} />}
            accessibilityLabel={t('mobile.nav.open_menu', 'Open navigation')}
            onPress={menu.open}
            testID="header-menu"
        />
    );
}

function HeaderTitle({
    title,
    subtitle,
    large,
    center,
    onPressTitle,
    titleHint,
}: Pick<ScreenHeaderProps, 'title' | 'subtitle' | 'center' | 'onPressTitle' | 'titleHint'> & { large: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const titleBlock = (
        <>
            <Text variant={large ? 'title' : 'subheading'} numberOfLines={1}>
                {title}
            </Text>
            {subtitle ? (
                <Text variant={large ? 'caption' : 'label'} tone="tertiary" numberOfLines={1}>
                    {subtitle}
                </Text>
            ) : null}
        </>
    );
    if (center) {
        /*
         * A centre slot replaces the title rather than sitting beside it.
         * `flex: 1` plus `alignItems: 'center'` is enough and an absolute
         * overlay is not needed: the space either side is symmetric as long as
         * the two clusters are the same width — the header balances a lone
         * drawer toggle for exactly that reason.
         */
        return <View style={styles.center}>{center}</View>;
    }
    if (onPressTitle) {
        // Button, not header, once it is tappable. TalkBack's heading
        // navigation loses this one title, and in exchange the tap stops
        // being undiscoverable — which is the trade the inline version in the
        // chat screen got backwards, announcing a heading that silently
        // navigated when you double-tapped it.
        return (
            <Pressable
                style={styles.titles}
                onPress={onPressTitle}
                accessibilityRole="button"
                accessibilityLabel={title}
                accessibilityHint={titleHint}
            >
                {titleBlock}
            </Pressable>
        );
    }
    return (
        <View style={styles.titles} accessibilityRole="header">
            {titleBlock}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: theme.spacing.lg,
        paddingRight: theme.spacing.sm,
        paddingVertical: theme.spacing.sm,
        gap: theme.spacing.xs,
    } satisfies ViewStyle,
    // One gutter. The back button is an IconButton with its own padding, so a
    // pushed header insets less to keep the arrow optically aligned with the
    // content below it.
    barBack: { paddingLeft: theme.spacing.sm } satisfies ViewStyle,
    center: { flex: 1, alignItems: 'center' } satisfies ViewStyle,
    balance: { width: theme.minTouch } satisfies ViewStyle,
    titles: { flex: 1, gap: 1 } satisfies ViewStyle,
});

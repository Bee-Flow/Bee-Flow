/**
 * The header. Singular.
 *
 * There were four treatments of the same 56dp of screen. This file was one of
 * them; `AppHeader` was a second (tab roots, `variant="title"`, 16dp gutter);
 * sixteen screens hand-rolled a third from an `arrow-left` IconButton and a
 * `variant="title"` Text; and the chat screen wrote a fourth so its title
 * could open the conversation's details. The result was a back arrow that
 * moved 8dp sideways and a title that changed size as you navigated, for no
 * reason a user could perceive as anything but a rendering fault.
 *
 * Two things follow from folding AppHeader in here rather than the reverse:
 *
 *   1. **Search and the bell survive below the tab roots.** They were on 6
 *      screens out of 60. Both are things you reach for FROM wherever you are
 *      rather than places you navigate to, and the bell carries the unread
 *      count, which is the only reason notifications do not need a tab. Losing
 *      them the moment you opened anything was the single largest thing this
 *      header was getting wrong.
 *   2. **Size is a prop, not a component.** `large` is the tab-root treatment;
 *      the default is everything else. A screen no longer picks its header by
 *      which import it happened to reach for.
 *
 * `onPressTitle` exists for the chat screen, which needs the title to open the
 * conversation's details — the title is the only place with room for it. It is
 * a parameter rather than a fifth copy.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { IconButton } from './Button';
import { Text } from './Text';
import { api } from '../api/client';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';

interface UnreadResponse {
    unread?: number;
    count?: number;
}

/**
 * Poll the unread count.
 *
 * Polling, not push: this app deliberately ships without Firebase (see
 * app.config.ts), so the badge is refreshed on an interval while the app is in
 * the foreground. 60s is useful without being a battery cost, and React Query
 * pauses it when the app is backgrounded, because focusManager is wired to
 * AppState in app/_layout.tsx.
 *
 * This now mounts on ~45 screens rather than 6, which is safe for one specific
 * reason worth writing down: React Query dedupes by key, so every mounted
 * header shares ONE observer, one interval and one request. Two headers are
 * never on screen at once anyway, but a push transition briefly overlaps them
 * and this is why that costs nothing.
 */
function useUnreadCount(enabled: boolean): number {
    const { data } = useQuery({
        queryKey: ['notifications', 'unread'],
        queryFn: async ({ signal }) => {
            const res = await api.get<UnreadResponse>('/api/notifications/unread-count', {
                signal,
                retry: false,
            });
            return res?.unread ?? res?.count ?? 0;
        },
        enabled,
        refetchInterval: 60_000,
        // A failing badge must never surface an error to the user — the count
        // is a nicety, and the screen behind it still works.
        retry: false,
        staleTime: 30_000,
    });
    return typeof data === 'number' ? data : 0;
}

export interface ScreenHeaderProps {
    title: string;
    subtitle?: string;
    /** This screen's own actions, placed before search and the bell. */
    actions?: ReactNode;
    /** Rendered before the title. Tab roots use it; pushed screens get Back. */
    leading?: ReactNode;
    /**
     * `large` is the tab-root treatment: a bigger title, a wider gutter, and
     * no back button. Everything pushed uses the default.
     */
    size?: 'default' | 'large';
    /** Defaults to router.back(); override for a screen with a custom escape. */
    onBack?: () => void;
    /** Hides the back button on a screen that is not pushed. */
    showBack?: boolean;
    /** Makes the title block a button — see `titleHint`. */
    onPressTitle?: () => void;
    /**
     * What tapping the title does. Required in spirit whenever `onPressTitle`
     * is given: a tappable heading that does not say so is a secret.
     */
    titleHint?: string;
    /** Turns off search and the bell — for a screen that IS one of them. */
    global?: boolean;
    /**
     * A control centred in place of the title — the Chat | Cowork pill.
     *
     * Replaces the title rather than joining it: a tab root's title repeats the
     * label already lit in the tab bar two inches below, so spending the centre
     * of the header on a mode switch costs nothing and buys the element the web
     * puts there.
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
    const theme = useTheme();
    const t = useTranslation();
    const router = useRouter();
    const large = size === 'large';
    // A large header is a tab root, which is never pushed and has nothing to
    // go back to.
    const back = showBack ?? !large;
    const unread = useUnreadCount(showGlobal);

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

    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                // One gutter. The back button is an IconButton with its own
                // padding, so a pushed header insets less to keep the arrow
                // optically aligned with the content below it.
                paddingLeft: back ? theme.spacing.sm : theme.spacing.lg,
                paddingRight: theme.spacing.sm,
                paddingVertical: theme.spacing.sm,
                gap: theme.spacing.xs,
            }}
        >
            {back ? (
                <IconButton
                    icon={<Feather name="arrow-left" size={20} color={theme.colors.textPrimary} />}
                    accessibilityLabel={t('common.back', 'Back')}
                    onPress={onBack ?? (() => router.back())}
                />
            ) : null}
            {leading}

            {center ? (
                /*
                 * A centre slot replaces the title rather than sitting beside
                 * it. `flex: 1` plus `alignItems: 'center'` is enough here and
                 * an absolute overlay is not needed: the left side of a tab
                 * root is empty by construction (`back` is false on a large
                 * header), so the remaining space is symmetric about the
                 * control as long as the right cluster is a fixed width — which
                 * it is, two IconButtons.
                 */
                <View style={{ flex: 1, alignItems: 'center' }}>{center}</View>
            ) : onPressTitle ? (
                // Button, not header, once it is tappable. TalkBack's heading
                // navigation loses this one title, and in exchange the tap
                // stops being undiscoverable — which is the trade the inline
                // version in the chat screen got backwards, announcing a
                // heading that silently navigated when you double-tapped it.
                <Pressable
                    style={{ flex: 1, gap: 1 }}
                    onPress={onPressTitle}
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    accessibilityHint={titleHint}
                >
                    {titleBlock}
                </Pressable>
            ) : (
                <View style={{ flex: 1, gap: 1 }} accessibilityRole="header">
                    {titleBlock}
                </View>
            )}

            {actions}

            {showGlobal ? (
                <>
                    <IconButton
                        icon={
                            <Feather name="search" size={20} color={theme.colors.textSecondary} />
                        }
                        accessibilityLabel={t('mobile.ui.search_everything', 'Search everything')}
                        onPress={() => router.push('/search')}
                    />
                    <View>
                        <IconButton
                            icon={
                                <Feather name="bell" size={20} color={theme.colors.textSecondary} />
                            }
                            accessibilityLabel={
                                unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
                            }
                            onPress={() => router.push('/notifications')}
                        />
                        {unread > 0 ? (
                            <View
                                pointerEvents="none"
                                style={{
                                    position: 'absolute',
                                    top: 6,
                                    right: 6,
                                    minWidth: 18,
                                    height: 18,
                                    paddingHorizontal: 4,
                                    borderRadius: 9,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: theme.colors.error,
                                }}
                            >
                                {/*
                                  * No font-size override. `label` is already
                                  * the scale's floor at 11px, and hardcoding 10
                                  * both went under it and opted the badge out
                                  * of the user's text-size setting — on the one
                                  * number in the app that exists to be noticed.
                                  */}
                                <Text
                                    variant="label"
                                    style={{ color: '#fff' }}
                                    maxFontSizeMultiplier={1.3}
                                >
                                    {unread > 99 ? '99+' : String(unread)}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                </>
            ) : null}
        </View>
    );
}

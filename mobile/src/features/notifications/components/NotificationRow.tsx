/**
 * One notification.
 *
 * Not a ListRow: this row has an unread dot, a category mark, an expandable
 * body and two trailing actions, which is more than that component's shape
 * carries. The touch target, padding and pressed state still match it.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import { NotificationRowActions } from './NotificationRowActions';
import { NotificationRowBody } from './NotificationRowBody';
import { targetForNotification } from '../model/route';
import { presentationFor, RESULT_CATEGORIES, type AppNotification, type CategoryPresentation } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            gap: theme.spacing.md,
            minHeight: 64,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
        },
        mark: { paddingTop: 2 },
        body: { flex: 1, gap: theme.spacing.xxs },
        titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        title: { flex: 1 },
        dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accentPrimary },
    });

function tintFor(tone: CategoryPresentation['tone'], colors: Theme['colors']): string {
    return {
        neutral: colors.textMuted,
        accent: colors.accentPrimary,
        success: colors.success,
        warning: colors.warning,
        error: colors.error,
    }[tone];
}

export interface NotificationRowProps {
    notification: AppNotification;
    expanded: boolean;
    onPress: () => void;
    /** Go where the notification points (an expanded result row's button). */
    onFollow: () => void;
    onToggleRead: () => void;
    onDelete: () => void;
    deleting: boolean;
}

/** What a tap on the row does, for a screen reader. A result opens in place; its button goes on. */
function hintFor(isResult: boolean, href: string | null, t: ReturnType<typeof useTranslation>): string {
    if (isResult) return t('mobile.notifications.hint_result', 'Shows the full result');
    return href ? t('mobile.notifications.hint_open', 'Opens the item this is about') : t('mobile.notifications.hint_message', 'Shows the full message');
}

export function NotificationRow({ notification, expanded, onPress, onFollow, onToggleRead, onDelete, deleting }: NotificationRowProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const presentation = presentationFor(notification.category);
    const target = targetForNotification(notification);
    const isResult = RESULT_CATEGORIES.has(notification.category);
    const background = notification.read ? 'transparent' : theme.colors.itemActiveBg;

    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`${presentation.label}: ${notification.title}`}
            accessibilityHint={hintFor(isResult, target.href, t)}
            accessibilityState={{ expanded, selected: !notification.read }}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.itemHoverBg : background }]}
        >
            <View style={styles.mark}>
                <Icon
                    name={presentation.icon}
                    size={18}
                    color={tintFor(presentation.tone, theme.colors)}
                />
            </View>

            <View style={styles.body}>
                <View style={styles.titleRow}>
                    <Text variant="subheading" numberOfLines={2} style={styles.title}>
                        {notification.title}
                    </Text>
                    {!notification.read ? <View accessibilityElementsHidden style={styles.dot} /> : null}
                </View>
                <NotificationRowBody
                    notification={notification}
                    expanded={expanded}
                    presentation={presentation}
                    unavailableReason={target.unavailableReason}
                    onFollow={isResult && target.href ? onFollow : undefined}
                />
            </View>

            <NotificationRowActions
                notification={notification}
                onToggleRead={onToggleRead}
                onDelete={onDelete}
                deleting={deleting}
            />
        </Pressable>
    );
}

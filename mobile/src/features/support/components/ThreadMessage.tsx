/** One message in a thread: who wrote it (and whether it was the AI), when, and what. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Text } from '@/shared/ui';

import { authorName } from '../model/status';
import type { SupportMessage } from '../model/types';

export function ThreadMessage({ entry }: { entry: SupportMessage }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const mine = entry.author_kind === 'requester';
    return (
        <View style={styles.message}>
            <View style={styles.meta}>
                <Text variant="caption" weight="semibold">
                    {authorName(entry.author_kind, entry.author_display)}
                </Text>
                {entry.author_kind === 'ai' ? <Badge label="Automated" tone="accent" /> : null}
                <Text variant="label" tone="tertiary">
                    {timeAgo(entry.created_at)}
                </Text>
            </View>
            <View
                style={[
                    styles.bubble,
                    { backgroundColor: mine ? theme.colors.userBubbleBg : theme.colors.bgTertiary },
                ]}
            >
                <Text variant="body" selectable>
                    {entry.body}
                </Text>
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        message: { gap: theme.spacing.xs },
        meta: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        bubble: { padding: theme.spacing.md, borderRadius: theme.radii.md },
    });

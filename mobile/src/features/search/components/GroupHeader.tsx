/**
 * One result group's heading, with what the group could not do: an error of
 * its own (the rest of the list still shows), or the note that it only matched
 * what the list route already sent.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, type IconName } from '@/shared/ui';

import type { ResultSection } from '../hooks/useSearch';
import type { SearchGroupKey } from '../model/types';

const GROUP_ICONS: Record<SearchGroupKey, IconName> = {
    places: 'Compass',
    chats: 'MessageSquare',
    notebooks: 'Book',
    documents: 'FileText',
    knowledge: 'Database',
    automations: 'Zap',
    transcripts: 'Mic',
};

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: {
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.xs,
            gap: theme.spacing.xxs,
        },
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    });

export function GroupHeader({ section }: { section: ResultSection }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const problem = section.error ? describeError(section.error) : null;

    return (
        <View style={styles.header}>
            <View style={styles.row}>
                <Icon name={GROUP_ICONS[section.key]} size={14} color={theme.colors.textMuted} />
                <Text variant="label" tone="tertiary" accessibilityRole="header">
                    {section.title.toUpperCase()}
                </Text>
                {/* Say so when a group could only match what the list route
                    already sent — otherwise "why didn't it find that word"
                    has no answer. */}
                {section.local && section.data.length > 0 ? (
                    <Text variant="label" tone="tertiary">
                        · searched on this device
                    </Text>
                ) : null}
            </View>
            {problem ? (
                <Text variant="caption" tone="warning">
                    {problem.title}. {problem.message}
                </Text>
            ) : null}
        </View>
    );
}

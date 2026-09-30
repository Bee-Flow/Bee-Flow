/** One entry of a project's activity trail: what happened, in words, and when. */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { activityLine } from '../model/activity';
import type { NameFor } from '../model/people';
import type { ActivityItem } from '../model/types';

export function ActivityRow({ item, nameFor }: { item: ActivityItem; nameFor: NameFor }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <Text variant="body">{activityLine(item, nameFor, t)}</Text>
            {item.createdAt ? (
                <Text variant="label" tone="tertiary">
                    {timeAgo(item.createdAt, { suffix: true })}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { gap: theme.spacing.xxs, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing[2.5] } satisfies ViewStyle,
});

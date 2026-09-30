/**
 * The line under a memory: its type, whether the retriever weighs it high,
 * whether it belongs to one agent only, and when it last changed — so "why
 * does it think that?" always has an answer.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Text } from '@/shared/ui';

import { importanceLabel, memoryTypeLabel, type Memory } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.spacing.xs },
    });

export function MemoryMeta({ memory }: { memory: Memory }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();

    return (
        <View style={styles.row}>
            <Badge label={memoryTypeLabel(memory.type)} />
            {importanceLabel(memory.importance) === 'High' ? (
                <Badge label={t('mobile.memory.weighted_high', 'Weighted high')} tone="accent" />
            ) : null}
            {memory.agent_id ? <Badge label={t('mobile.memory.one_agent_only', 'One agent only')} /> : null}
            <Text variant="label" tone="tertiary">
                {timeAgo(memory.updated_at || memory.created_at, { suffix: true })}
            </Text>
        </View>
    );
}

/**
 * The one-line summary above the source list: how many sources are usable
 * right now, and whether anything is still landing. A notebook whose sources
 * are all still processing will answer questions badly, and saying so up front
 * is kinder than letting the model do it.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Text } from '@/shared/ui';

import { isWorking, readyLine } from '../model/format';
import type { NotebookSource } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' } });

export function SourceSummary({ sources }: { sources: NotebookSource[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const ready = sources.filter((s) => s.status === 'ready').length;
    const working = sources.filter(isWorking).length;
    const failed = sources.filter((s) => s.status === 'error').length;

    return (
        <View style={styles.row} accessibilityLiveRegion={working > 0 ? 'polite' : 'none'}>
            <Text variant="caption" tone="tertiary">
                {readyLine(ready, sources.length)}
            </Text>
            {working > 0 ? (
                <Badge label={t('notebooks.processing_sources', '{count} sources processing', { count: working })} tone="warning" />
            ) : null}
            {failed > 0 ? <Badge label={t('notebooks.failed_sources', '{count} sources failed', { count: failed })} tone="error" /> : null}
        </View>
    );
}

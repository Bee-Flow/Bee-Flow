/**
 * How many results, as a live region: after typing, the only feedback a
 * screen-reader user gets is this line.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ line: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xs } });

export function ResultCount({ total, searching }: { total: number; searching: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const idle = searching ? t('studio.search.loading', 'Searching…') : t('project_chat.search_no_matches', 'No matches');
    return (
        <View accessibilityLiveRegion="polite" style={styles.line}>
            <Text variant="label" tone="tertiary">
                {total === 0 ? idle : nOf(t, 'sidebar.search_result_count', total, ['{count} result', '{count} results'])}
            </Text>
        </View>
    );
}

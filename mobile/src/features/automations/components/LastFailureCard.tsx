/**
 * The last run's failure, at the top of an automation's screen. Everything
 * else there is secondary to "why did last night's run not happen?".
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { InlineMarkdown } from '@/shared/markdown';
import { Button, Card, Icon, Text } from '@/shared/ui';

import { errorClassText } from '../model/runWords';
import type { AutomationRun } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
        heading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        title: { flex: 1 },
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
    });

export function LastFailureCard({ run, automationId }: { run: AutomationRun; automationId: string }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const why = errorClassText(run.errorClass, t);
    return (
        <Card>
            <View style={styles.body}>
                <View style={styles.heading}>
                    <Icon name="CircleAlert" size={18} color={theme.colors.error} />
                    <Text variant="subheading" tone="error" style={styles.title}>
                        {t('mobile.automations.last_failure.title', 'The last run failed')}
                    </Text>
                    <Text variant="label" tone="tertiary">
                        {timeAgo(run.startedAt)}
                    </Text>
                </View>
                <InlineMarkdown value={run.error ?? ''} variant="body" selectable />
                {why ? (
                    <Text variant="caption" tone="error">
                        ({why})
                    </Text>
                ) : null}
                <View style={styles.actions}>
                    <Button
                        label={t('mobile.automations.last_failure.open', 'See what happened')}
                        variant="secondary"
                        onPress={() => router.push(`/automations/${automationId}/runs?runId=${run.id}`)}
                    />
                </View>
            </View>
        </Card>
    );
}

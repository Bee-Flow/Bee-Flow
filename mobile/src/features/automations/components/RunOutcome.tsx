/**
 * How a run ended, above its facts: the error — at the top, in full,
 * selectable, the single reason most people open this screen — or its
 * summary, plus the two notes that change how the outcome reads.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { InlineMarkdown, Markdown } from '@/shared/markdown';
import { Banner, Card, Icon, Text } from '@/shared/ui';

import { errorClassText } from '../model/runWords';
import type { AutomationRun } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.sm },
        heading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        title: { flex: 1 },
    });

function FailureCard({ run }: { run: AutomationRun }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    // The web's note beside a failed run (ExecutionBar.jsx): the class in
    // words, or nothing — never the class token ("rate_limit").
    const why = errorClassText(run.errorClass, t);
    return (
        <Card>
            <View style={styles.body}>
                <View style={styles.heading}>
                    <Icon name="CircleAlert" size={18} color={theme.colors.error} />
                    <Text variant="subheading" tone="error" style={styles.title}>
                        {t('mobile.automations.outcome.what_went_wrong', 'What went wrong')}
                    </Text>
                </View>
                <InlineMarkdown value={run.error ?? ''} variant="body" selectable />
                {why ? (
                    <Text variant="caption" tone="error">
                        ({why})
                    </Text>
                ) : null}
            </View>
        </Card>
    );
}

export function RunOutcome({ run, failed }: { run: AutomationRun; failed: boolean }) {
    const t = useTranslation();
    const handled = run.handledErrorCount;
    return (
        <>
            {failed && run.error ? <FailureCard run={run} /> : null}

            {run.summary && !failed ? (
                <Card>
                    <Markdown value={run.summary} streaming={false} />
                </Card>
            ) : null}

            {handled > 0 ? (
                <Banner tone="warning" icon="Shield">
                    {nOf(t, 'mobile.automations.outcome.handled', handled, [
                        '{count} step failed and was caught by an error branch — the run still finished.',
                        '{count} steps failed and were caught by an error branch — the run still finished.',
                    ])}
                </Banner>
            ) : null}

            {run.journeyRunId && run.journeyRunId !== run.id ? (
                <Banner tone="info">
                    {t(
                        'mobile.automations.outcome.journey',
                        'This run paused and continued in a later leg. The outcome and the timeline below are the whole journey.',
                    )}
                </Banner>
            ) : null}
        </>
    );
}

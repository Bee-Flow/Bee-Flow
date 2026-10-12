/** What an app action answered: its status, any error, and its output. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { StatusIcon, previewValue, statusLabel, statusToken } from '@/features/automations';
import { Badge, Banner, Spinner, Text } from '@/shared/ui';

import type { AppActionResult } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        box: {
            gap: theme.spacing.sm,
            padding: theme.spacing.md,
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.bgTertiary,
        },
        heading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        word: { flex: 1 },
    });

/** The output; "nothing to show" only once the run has ended, not while it waits or runs. */
function ResultOutput({ result, ended }: { result: AppActionResult; ended: boolean }) {
    const t = useTranslation();
    const output = previewValue(result.output);
    if (output) {
        return (
            <Text variant="code" tone="secondary" selectable>
                {output}
            </Text>
        );
    }
    if (result.error || !ended) return null;
    return (
        <Text variant="caption" tone="tertiary">
            {t('mobile.apps.no_output', 'Finished with nothing to show.')}
        </Text>
    );
}

export function ActionResult({ result, polling }: { result: AppActionResult; polling: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);

    if (result.status === 'skipped') {
        return <Banner tone="warning">{result.message ?? t('mobile.apps.already_running', 'This automation was already running.')}</Banner>;
    }

    const token = statusToken(result.status === 'pending' ? 'running' : (result.status ?? 'idle'));

    return (
        <View accessibilityLiveRegion="polite" style={styles.box}>
            <View style={styles.heading}>
                {polling ? <Spinner /> : <StatusIcon status={result.status ?? 'idle'} size={16} />}
                <Text variant="caption" weight="medium" style={styles.word}>
                    {polling ? t('automations.runs.still_running', 'Still running…') : statusLabel(t, token)}
                </Text>
                {result.approvalId ? <Badge label={t('mobile.apps.needs_approval', 'Needs approval')} tone="warning" /> : null}
            </View>

            {result.error ? (
                <Text variant="caption" tone="error" selectable>
                    {result.error}
                </Text>
            ) : null}

            <ResultOutput result={result} ended={!polling && !token.live} />
        </View>
    );
}

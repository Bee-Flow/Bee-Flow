/**
 * The rules list's header (the intro, a failed "Rule", and the one banner
 * that stands in for every missing run count) and its empty states.
 *
 * Unreadable counts are said ONCE, above the list, not as a 0 on each card:
 * a zero would be a claim about runs nobody could count. A licence refusal
 * from /api/automation is worded as one rather than shown as its token.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Banner, EmptyState, ErrorState, LoadingState, Text } from '@/shared/ui';

import { licenceMessage } from '../model/sentences';

const styles = StyleSheet.create({ header: { gap: 8, paddingBottom: 8 } });

export function RulesListHeader({ createError, countsMissing }: { createError: unknown; countsMissing: boolean }) {
    const t = useTranslation();
    return (
        <View style={styles.header}>
            <Text variant="caption" tone="tertiary">
                {t(
                    'meetings.rules_intro',
                    'What runs by itself once a meeting note is ready. These are your own rules — a colleague sees theirs.',
                )}
            </Text>
            {createError ? (
                <Banner tone="error">
                    {licenceMessage(createError as Error, t) ?? describeError(createError).message}
                </Banner>
            ) : null}
            {countsMissing ? (
                <Banner tone="warning">
                    {t('meetings.rules_runs_unreadable', 'Couldn’t read how often these ran, so no rule shows a count.')}
                </Banner>
            ) : null}
        </View>
    );
}

export function RulesEmpty({
    query,
    onRetry,
}: {
    query: { isLoading: boolean; isError: boolean; error: unknown };
    onRetry: () => void;
}) {
    const t = useTranslation();
    if (query.isLoading) return <LoadingState label={t('meetings.rules_loading', 'Loading rules…')} />;
    if (query.isError) {
        const licence = licenceMessage(query.error as Error, t);
        if (licence) return <EmptyState icon="Lock" title={licence} />;
        return <ErrorState error={query.error} onRetry={onRetry} />;
    }
    return (
        <EmptyState
            icon="Workflow"
            title={t('meetings.rules_empty_title', 'No rules yet')}
            message={t(
                'meetings.rules_empty_desc',
                'A rule picks up a meeting note the moment it is ready — files it, passes it on, or tells someone.',
            )}
        />
    );
}

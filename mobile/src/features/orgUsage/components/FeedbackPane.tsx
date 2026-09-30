/**
 * What people thought of the answers (OrgFeedbackPanel.jsx): the positive
 * rate, the counts, a filter, and every item in a virtualised list. The
 * conversation snapshot is not rendered on the phone; a row says one exists.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { shortModel } from '@/features/usage';
import { absoluteDate } from '@/shared/lib/display';
import { useUserRefresh } from '@/shared/patterns';
import { Banner, EmptyState, ErrorState, FilterPills, ListRow, ListSkeleton, Meter, Stat } from '@/shared/ui';

import { useOrgFeedback } from '../hooks/queries';
import type { RangePreset } from '../model/range';
import { feedbackNeedsReview, filterFeedback, positiveRate, type FeedbackFilter } from '../model/report';
import type { FeedbackItem } from '../model/types';

function FeedbackRow({ item }: { item: FeedbackItem }) {
    const t = useTranslation();
    const who = item.userId ?? t('org.feedback_anonymous', 'Anonymous');
    const about = [item.agentName, item.model ? shortModel(item.model) : null, item.source].filter(Boolean).join(' · ');
    return (
        <ListRow
            title={`${item.rating === 'up' ? '👍' : '👎'} ${item.comment ?? who}`}
            subtitle={item.comment ? [who, about].filter(Boolean).join(' · ') : about || undefined}
            meta={absoluteDate(item.createdAt)}
            wrapTitle
        />
    );
}

const renderItem: ListRenderItem<FeedbackItem> = ({ item }) => <FeedbackRow item={item} />;
const keyOf = (item: FeedbackItem) => item.id;

export function FeedbackPane({ range }: { range: RangePreset }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [filter, setFilter] = useState<FeedbackFilter>('all');
    const feedback = useOrgFeedback(range, true);
    const refresh = useUserRefresh(() => feedback.refetch());
    if (feedback.isLoading) return <ListSkeleton rows={5} />;
    if (feedback.isError || !feedback.data) return <ErrorState error={feedback.error} onRetry={() => void feedback.refetch()} />;
    const { summary, items } = feedback.data;
    const rate = positiveRate(summary);
    const header = (
        <View style={styles.header}>
            {feedbackNeedsReview(summary) ? (
                <Banner tone="warning">
                    {t('mobile.orgUsage.feedback_review', 'Positive rate {pct}% on {n} items — review the negative comments.', { pct: Math.round((rate ?? 0) * 100), n: summary.total })}
                </Banner>
            ) : null}
            <Meter label={t('mobile.orgUsage.positive_rate', 'Positive rate')} valueLabel={rate === null ? '—' : `${Math.round(rate * 100)}%`} fraction={rate} />
            <View style={styles.stats}>
                <Stat label={t('org.feedback_positive', 'Positive')} value={String(summary.up)} />
                <Stat label={t('org.feedback_negative', 'Negative')} value={String(summary.down)} tone={summary.down > 0 ? 'warning' : 'primary'} />
                <Stat label={t('org.feedback_with_comments', 'With Comments')} value={String(summary.withComments)} />
            </View>
            <FilterPills
                value={filter}
                onChange={setFilter}
                scroll
                testID="feedback-filter"
                options={[
                    { value: 'all', label: t('org.feedback_chip_all', 'All') },
                    { value: 'positive', label: t('org.feedback_chip_positive', '👍 Positive') },
                    { value: 'negative', label: t('org.feedback_chip_negative', '👎 Negative') },
                    { value: 'comments', label: t('org.feedback_chip_comments', '💬 Comments') },
                ]}
            />
        </View>
    );
    return (
        <FlatList
            data={filterFeedback(items, filter)}
            keyExtractor={keyOf}
            renderItem={renderItem}
            ListHeaderComponent={header}
            ListEmptyComponent={<EmptyState icon="ThumbsUp" title={t('org.feedback_empty', 'No feedback entries')} />}
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing.md, padding: theme.spacing.lg },
        stats: { flexDirection: 'row', gap: theme.spacing.md },
    });

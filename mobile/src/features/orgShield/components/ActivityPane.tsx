/**
 * "What happened" — evidence, where the other tabs are policy, so it has no
 * Save bar. The endpoints derive the organisation from the session, which on
 * the phone is always the org being edited. Behind `advanced_usage_monitoring`
 * like the web; fetched only while this tab is open.
 */

import React, { useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Banner, EmptyState, ErrorState, ListSkeleton, Segmented } from '@/shared/ui';

import { EgressItem, EventRow } from './ActivityRows';
import { ActivitySummary } from './ActivitySummary';
import { useShieldActivity } from '../hooks/queries';
import type { Lock } from '../hooks/useShieldLicence';
import type { EgressRow, GuardEvent } from '../model/activityTypes';

type Item = { kind: 'event'; key: string; event: GuardEvent } | { kind: 'egress'; key: string; row: EgressRow };

const renderItem: ListRenderItem<Item> = ({ item }) =>
    item.kind === 'event' ? <EventRow event={item.event} /> : <EgressItem row={item.row} />;
const keyOf = (item: Item) => item.key;

type Range = '7' | '30' | '90';

export function ActivityPane({ licence, shieldEnabled }: { licence: Lock; shieldEnabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [range, setRange] = useState<Range>('30');
    const [list, setList] = useState<'events' | 'calls'>('events');
    const activity = useShieldActivity(Number(range), licence.open);
    const refresh = useUserRefresh(() => activity.refetch());

    if (!licence.open) {
        return <EmptyState icon="Lock" title={t('admin.shield_tab_activity', 'What happened')} message={licence.hint ?? undefined} />;
    }
    const data = activity.data;
    const items: Item[] = !data
        ? []
        : list === 'events'
            ? data.events.map((event) => ({ kind: 'event', key: `e${event.id}`, event }))
            : data.egress.map((row) => ({ kind: 'egress', key: `c${row.id}`, row }));
    const header = (
        <View style={styles.header}>
            {!shieldEnabled ? (
                <Banner tone="info">{t('mobile.orgShield.activity_shield_off', 'Protection is off right now. History from when it was on is still shown.')}</Banner>
            ) : null}
            <Segmented
                accessibilityLabel={t('usage.range', 'Range')}
                value={range}
                onChange={setRange}
                options={[
                    { value: '7', label: t('usage.range_7d', '7d') },
                    { value: '30', label: t('usage.range_30d', '30d') },
                    { value: '90', label: t('usage.range_90d', '90d') },
                ]}
                fullWidth
            />
            {data ? <ActivitySummary activity={data} /> : null}
            <Segmented
                accessibilityLabel={t('mobile.orgShield.list_label', 'Which list')}
                value={list}
                onChange={setList}
                options={[
                    { value: 'events', label: t('mobile.orgShield.list_events', 'Caught'), count: data?.events.length ?? null },
                    { value: 'calls', label: t('mobile.orgShield.list_calls', 'Outbound calls'), count: data?.egress.length ?? null },
                ]}
                fullWidth
            />
        </View>
    );
    if (activity.isLoading) return <ListSkeleton rows={6} />;
    if (activity.isError) return <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />;
    return (
        <FlatList
            data={items}
            keyExtractor={keyOf}
            renderItem={renderItem}
            ListHeaderComponent={header}
            ListEmptyComponent={<EmptyState icon="ShieldCheck" title={t('mobile.orgShield.activity_empty', 'Nothing in this period')} />}
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            testID="activity-list"
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing.md, padding: theme.spacing.lg },
    });

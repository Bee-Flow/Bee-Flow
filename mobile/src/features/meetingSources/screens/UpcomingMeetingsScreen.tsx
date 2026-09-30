/**
 * Upcoming meetings: the calendar meetings with a Nextcloud Talk room or a
 * Google Meet link in the next 48 hours, each with its record switch — the
 * web's Upcoming segment (agent-hub UpcomingMeetings.jsx), as a screen.
 *
 * The switch shows the state the server says will hold, which is not always
 * what was asked for; the footer says what the OTHER participants get, and
 * only for providers where a note will actually be made.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useTranslation, translate } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { EmptyState, LoadingState, Screen, ScreenHeader, Text } from '@/shared/ui';

import { UpcomingBanners } from '../components/UpcomingBanners';
import { UpcomingRow } from '../components/UpcomingRow';
import { useUpcoming, type Upcoming } from '../hooks/useUpcoming';
import type { UpcomingRow as Row } from '../model/rows';

const styles = StyleSheet.create({
    list: { paddingHorizontal: 16, paddingBottom: 48, gap: 8 },
    header: { gap: 8, paddingBottom: 8 },
    footer: { gap: 6, paddingTop: 12 },
});

const keyOf = (row: Row) => row.key;

function Footer({ upcoming }: { upcoming: Upcoming }) {
    if (!upcoming.notices.length) return null;
    return (
        <View style={styles.footer}>
            {upcoming.notices.map((notice) => (
                <Text key={notice.i18nKey} variant="caption" tone="tertiary">
                    {translate(notice.i18nKey, notice.en)}
                </Text>
            ))}
        </View>
    );
}

function Empty({ upcoming }: { upcoming: Upcoming }) {
    const t = useTranslation();
    if (upcoming.loading) return <LoadingState label={t('meetings.upcoming_loading', 'Loading meetings…')} />;
    // A provider that failed has its own banner; "no meetings" would be a claim.
    if (upcoming.talk.isError || upcoming.meet.isError) return null;
    return (
        <EmptyState
            icon="Calendar"
            title={t('meetings.upcoming_empty_title', 'No upcoming meetings')}
            message={t(
                'meetings.upcoming_empty_desc',
                'Meetings in your calendar with a Nextcloud Talk conversation or a Google Meet link show up here.',
            )}
        />
    );
}

export function UpcomingMeetingsScreen() {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const upcoming = useUpcoming();

    return (
        <Screen edges={['top']}>
            <ScreenHeader
                title={t('mobile.recording.tools_upcoming', 'Upcoming meetings')}
                subtitle={t('meetings.upcoming_intro', 'Your upcoming meetings — toggle which ones to auto-record.')}
            />
            <FlatList<Row>
                data={upcoming.rows}
                keyExtractor={keyOf}
                contentContainerStyle={styles.list}
                ListHeaderComponent={
                    <View style={styles.header}>
                        <UpcomingBanners upcoming={upcoming} />
                    </View>
                }
                renderItem={({ item }) => (
                    <UpcomingRow
                        row={item}
                        talkMode={upcoming.talk.data?.recordingMode ?? 'audio'}
                        busy={upcoming.busy === item.key}
                        overridden={upcoming.overridden[item.key] === true}
                        error={upcoming.errors[item.key]}
                        onToggle={() => upcoming.toggle(item)}
                        onOpenNote={(id) => router.push(`/recordings/${id}`)}
                    />
                )}
                ListEmptyComponent={<Empty upcoming={upcoming} />}
                ListFooterComponent={<Footer upcoming={upcoming} />}
                refreshControl={
                    <RefreshControl
                        refreshing={upcoming.refreshing}
                        onRefresh={upcoming.refresh}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            />
        </Screen>
    );
}

/**
 * What is waiting on your decision.
 *
 * `app/approvals/` contained only `[id].tsx`. Its sole entrance was an unread
 * notification, so a pending approval whose notification you had already
 * dismissed was unreachable, and a DECIDED one had no door at all — there was
 * nowhere in the app to see what you had agreed to.
 *
 * This is the phone's answer to "what came back, and what needs me", which is
 * the question people pick a phone up to ask.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { automateKeys, listApprovals } from '../../src/features/automate/api';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { describeError, EmptyState, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Segmented } from '../../src/ui/Segmented';

type Tab = 'pending' | 'all';

export default function ApprovalsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const [tab, setTab] = useState<Tab>('pending');

    const approvals = useQuery({
        queryKey: automateKeys.approvals(tab),
        queryFn: ({ signal }) => listApprovals(tab, signal),
        staleTime: 30_000,
    });

    const rows = approvals.data ?? [];

    return (
        <Screen edges={['top']}>
            <ScreenHeader title="Approvals" showBack />

            <View
                style={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.sm,
                    alignItems: 'flex-start',
                }}
            >
                <Segmented
                    accessibilityLabel="Waiting or everything"
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: 'pending', label: 'Waiting' },
                        { value: 'all', label: 'Everything' },
                    ]}
                />
            </View>

            {approvals.isLoading ? (
                <ListSkeleton />
            ) : approvals.isError ? (
                /*
                 * A licence can withhold this whole surface — the list route is
                 * behind requireModule('approvals'), while DECIDING one
                 * deliberately is not. describeError knows the difference
                 * between "retry" and "your plan does not include this", and
                 * saying so is better than a spinner that never resolves.
                 */
                <ErrorState
                    error={approvals.error}
                    onRetry={
                        describeError(approvals.error).retryable
                            ? () => void approvals.refetch()
                            : undefined
                    }
                />
            ) : rows.length === 0 ? (
                <EmptyState
                    icon="check-circle"
                    title={tab === 'pending' ? 'Nothing is waiting on you' : 'No approvals yet'}
                    message={
                        tab === 'pending'
                            ? 'When an automation needs a decision, it appears here and as a notification.'
                            : 'Automations that pause for a decision keep their history here.'
                    }
                />
            ) : (
                <ScrollView
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}
                    refreshControl={
                        <RefreshControl
                            refreshing={approvals.isRefetching}
                            onRefresh={() => void approvals.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                >
                    {rows.map((a) => (
                        <ListRow
                            key={a.id}
                            title={a.prompt}
                            wrapTitle
                            subtitle={a.automationTitle || a.projectTitle || undefined}
                            meta={relativeTime(a.decidedAt ?? a.createdAt)}
                            leading={
                                <Feather
                                    name={
                                        a.status === 'pending'
                                            ? 'clock'
                                            : a.status === 'approved'
                                              ? 'check'
                                              : 'x'
                                    }
                                    size={16}
                                    color={
                                        a.status === 'pending'
                                            ? theme.colors.warning
                                            : a.status === 'approved'
                                              ? theme.colors.success
                                              : theme.colors.textMuted
                                    }
                                />
                            }
                            trailing={
                                a.status !== 'pending' ? (
                                    <Badge label={a.status} tone="neutral" />
                                ) : undefined
                            }
                            onPress={() => router.push(`/approvals/${a.id}`)}
                        />
                    ))}
                </ScrollView>
            )}
        </Screen>
    );
}

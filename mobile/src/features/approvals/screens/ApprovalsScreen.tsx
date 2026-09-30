/**
 * What is waiting on your decision.
 *
 * `app/approvals/` contained only `[id].tsx`. Its sole entrance was an unread
 * notification, so a pending approval whose notification you had already
 * dismissed was unreachable, and a DECIDED one had no door at all — there was
 * nowhere in the app to see what you had agreed to.
 *
 * A licence can withhold this whole surface (the list route is behind
 * requireModule('approvals'), while DECIDING one deliberately is not);
 * ErrorState, through describeError, says "your plan does not include this"
 * rather than offering a retry that cannot help.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useIsOrgAdmin } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Screen, ScreenHeader, Segmented } from '@/shared/ui';

import { ApprovalRow } from '../components/ApprovalRow';
import { useApprovals } from '../hooks/queries';
import type { ApprovalScope } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        tabs: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm, alignItems: 'flex-start' },
        list: { paddingBottom: theme.spacing.xxxl },
    });

export function ApprovalsScreen({ initialScope = 'pending' }: { initialScope?: ApprovalScope }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    // The web's Organisation switch, for the one person who may read the whole record.
    const orgAdmin = useIsOrgAdmin();
    const [tab, setTab] = useState<ApprovalScope>(initialScope === 'org' && !orgAdmin ? 'pending' : initialScope);
    const approvals = useApprovals(tab, { staleTime: 30_000, poll: true });
    const waiting = tab === 'pending';

    return (
        <Screen edges={['top']}>
            <ScreenHeader title="Approvals" showBack />

            <View style={styles.tabs}>
                <Segmented
                    accessibilityLabel="Waiting or everything"
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: 'pending', label: 'Waiting' },
                        { value: 'all', label: 'Everything' },
                        ...(orgAdmin ? [{ value: 'org' as const, label: t('approvals.scope_org', 'Organisation') }] : []),
                    ]}
                />
            </View>

            <QueryList
                query={approvals}
                keyExtractor={(a) => a.id}
                renderItem={({ item }) => (
                    <ApprovalRow approval={item} onPress={() => router.push(`/approvals/${item.id}`)} />
                )}
                separator="none"
                contentContainerStyle={styles.list}
                empty={{
                    icon: 'CircleCheckBig',
                    title: waiting ? 'Nothing is waiting on you' : 'No approvals yet',
                    message: waiting
                        ? 'When an automation needs a decision, it appears here and as a notification.'
                        : 'Automations that pause for a decision keep their history here.',
                }}
            />
        </Screen>
    );
}

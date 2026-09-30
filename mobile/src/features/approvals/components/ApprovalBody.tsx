/**
 * The decision itself: its state, the question, the details its author wrote,
 * and the facts around it.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown/Markdown';
import { Badge, Button, Text } from '@/shared/ui';

import { ApprovalFacts } from './ApprovalFacts';
import { approvalStatusLabel, approvalWhenLine } from '../model/status';
import type { ApprovalDetail } from '../model/types';

const STATUS_TONE: Record<string, 'success' | 'error' | 'warning' | 'neutral'> = {
    approved: 'success',
    rejected: 'error',
    expired: 'warning',
    cancelled: 'warning',
    pending: 'neutral',
};

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { padding: theme.spacing.lg, gap: theme.spacing.lg, paddingBottom: theme.spacing.xxxl },
        heading: { gap: theme.spacing.sm },
        state: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    });

export function ApprovalBody({ detail }: { detail: ApprovalDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const { approval } = detail;
    const pending = approval.status === 'pending';

    return (
        <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.heading}>
                <View style={styles.state}>
                    <Badge label={approvalStatusLabel(approval.status, t)} tone={STATUS_TONE[approval.status] ?? 'neutral'} />
                    <Text variant="caption" tone="tertiary">
                        {approvalWhenLine(approval, t)}
                    </Text>
                </View>
                <Text variant="heading">{approval.prompt || t('approvals.untitled', 'Approval requested')}</Text>
            </View>

            {approval.detailsMd ? <Markdown value={approval.detailsMd} /> : null}

            <ApprovalFacts approval={approval} />

            {/*
              * Only for a run-backed approval, and only once it is decided —
              * before that the run is paused on this very question and the run
              * screen has nothing to add.
              */}
            {approval.source === 'run' && approval.automationId && !pending ? (
                <Button
                    label={t('approvals.open_run', 'Open the run')}
                    variant="secondary"
                    onPress={() => router.push(`/automations/${approval.automationId}/runs`)}
                />
            ) : null}

            {pending && !detail.canDecide ? (
                <Text variant="caption" tone="tertiary">
                    {t(
                        'mobile.approvals.waiting_on_other',
                        'This is waiting on someone else. You can see it because it concerns something of yours.',
                    )}
                </Text>
            ) : null}
        </ScrollView>
    );
}

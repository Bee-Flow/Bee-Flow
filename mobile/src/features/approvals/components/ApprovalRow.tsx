/**
 * One approval in the inbox: the question, where it came from, and its state.
 * A test run's approval wears a "Test" chip: it went to the person testing
 * only, and deciding it moves nothing in production.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { approvalStatusLabel } from '../model/status';
import type { Approval } from '../model/types';

type Glyph = { name: 'Clock' | 'Check' | 'X'; tone: 'warning' | 'success' | 'textMuted' };

function glyphFor(status: Approval['status']): Glyph {
    if (status === 'pending') return { name: 'Clock', tone: 'warning' };
    if (status === 'approved') return { name: 'Check', tone: 'success' };
    return { name: 'X', tone: 'textMuted' };
}

const makeStyles = (theme: Theme) => StyleSheet.create({ chips: { flexDirection: 'row', gap: theme.spacing.xs } });

function Chips({ approval }: { approval: Approval }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const settled = approval.status !== 'pending';
    if (!approval.isTest && !settled) return null;
    return (
        <View style={styles.chips}>
            {approval.isTest ? <Badge label={t('mobile.runs.test_marker', 'Test')} tone="ai" testID="approval-test-chip" /> : null}
            {settled ? <Badge label={approvalStatusLabel(approval.status, t)} tone="neutral" /> : null}
        </View>
    );
}

export function ApprovalRow({ approval, onPress }: { approval: Approval; onPress: () => void }) {
    const theme = useTheme();
    const glyph = glyphFor(approval.status);
    return (
        <ListRow
            title={approval.prompt}
            wrapTitle
            subtitle={approval.automationTitle || approval.projectTitle || undefined}
            meta={timeAgo(approval.decidedAt ?? approval.createdAt)}
            leading={<Icon name={glyph.name} size={16} color={theme.colors[glyph.tone]} />}
            trailing={approval.isTest || approval.status !== 'pending' ? <Chips approval={approval} /> : undefined}
            onPress={onPress}
        />
    );
}

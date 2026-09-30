/** Where a held action stands, in the card's tinted header. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ConfirmDecision } from '@/features/chat/model/toolConfirm';
import { Icon, Text, tint, type IconName } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing[2.5] },
    grow: { flex: 1 },
    approved: { backgroundColor: tint(theme.colors.success, 8) },
    pending: { backgroundColor: tint(theme.colors.warning, 8) },
    quiet: { backgroundColor: theme.colors.bgTertiary },
});

function wordsFor(status: ConfirmDecision['status'], by: ConfirmDecision['by']): { key: string; en: string } {
    if (status === 'approved') {
        return by === 'session'
            ? { key: 'agent_studio.test.tool_confirm_approved_next', en: 'You approved this — it runs on your next message' }
            : { key: 'agent_studio.test.tool_confirm_approved', en: 'You approved this — it ran' };
    }
    if (status === 'declined') return { key: 'agent_studio.test.tool_confirm_declined', en: 'You declined this — it did not run' };
    if (status === 'unknown') return { key: 'agent_studio.test.tool_confirm_unknown', en: 'Could not tell whether this ran' };
    return { key: 'agent_studio.test.tool_confirm_title', en: 'Wanted to do this — it has not run' };
}

export function ToolConfirmHeader({ status, by, sends }: ConfirmDecision & { sends: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const quiet = status === 'declined' || status === 'unknown';
    const icon: IconName =
        status === 'approved' ? 'Check' : status === 'declined' ? 'X' : status === 'unknown' ? 'CircleQuestionMark' : sends ? 'TriangleAlert' : 'ShieldQuestionMark';
    const color = status === 'approved' ? theme.colors.success : quiet ? theme.colors.textTertiary : theme.colors.warning;
    const words = wordsFor(status, by);
    return (
        <View style={[styles.head, status === 'approved' ? styles.approved : quiet ? styles.quiet : styles.pending]}>
            <Icon name={icon} size={14} color={color} />
            <Text variant="label" weight="semibold" tone={status === 'approved' ? 'success' : quiet ? 'tertiary' : 'warning'} style={styles.grow}>
                {t(words.key, words.en).toUpperCase()}
            </Text>
        </View>
    );
}

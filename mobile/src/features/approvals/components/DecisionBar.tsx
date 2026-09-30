/**
 * Reject and Approve, side by side and equal. Neither is painted as the
 * dangerous answer here; only the confirmation sheet marks a rejection red.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon } from '@/shared/ui';

import type { ApprovalDecision } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: {
            flexDirection: 'row',
            gap: theme.spacing.md,
            padding: theme.spacing.lg,
            borderTopWidth: 1,
            borderTopColor: theme.colors.borderSubtle,
        },
        half: { flex: 1 },
    });

export function DecisionBar({ onChoose }: { onChoose: (decision: ApprovalDecision) => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.bar}>
            <Button label="Reject" variant="secondary" style={styles.half} onPress={() => onChoose('reject')} />
            <Button
                label="Approve"
                style={styles.half}
                onPress={() => onChoose('approve')}
                icon={<Icon name="Check" size={16} color={theme.colors.accentPrimaryFg} />}
            />
        </View>
    );
}

/**
 * One graded step, or one earlier run, of the Test tab. A status the app does
 * not know is drawn as a warning, never as a pass (model/testRun stepStatus).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Icon, Text, type IconName } from '@/shared/ui';

import { stepStatus, type StepStatus } from '../model/testRun';

const GLYPH: Readonly<Record<StepStatus, IconName>> = { ok: 'Check', warning: 'TriangleAlert', error: 'CircleAlert' };

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md },
        grow: { flex: 1, gap: 2 },
        flagged: { borderColor: theme.colors.warning },
    });

export function TestResultRow({ title, detail, status }: { title: string; detail: string; status: string }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const s = stepStatus(status);
    const ink = s === 'ok' ? theme.colors.successInk : s === 'error' ? theme.colors.errorInk : theme.colors.warningInk;
    return (
        <Card style={s === 'ok' ? undefined : styles.flagged} testID="skill-test-row">
            <View style={styles.row}>
                <View style={styles.grow}>
                    <Text variant="body" weight="medium">
                        {title}
                    </Text>
                    {detail ? (
                        <Text variant="caption" tone="tertiary">
                            {detail}
                        </Text>
                    ) : null}
                </View>
                <Icon name={GLYPH[s]} size={18} color={ink} />
            </View>
        </Card>
    );
}

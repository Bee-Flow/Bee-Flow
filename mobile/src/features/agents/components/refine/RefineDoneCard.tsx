/**
 * The "Done" turn — the web's RefineDoneCard: what the refine actually
 * changed, a way to try the agent, and Undo.
 *
 * An empty diff is a sentence, not an empty list. Undo never disappears: when
 * it cannot run it says why (no restore point, or a newer change on top).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { changeLabel, undoLabel, undoStateOf, type RefineTurn } from '@/features/agents/model/refineTurns';
import { Button, Card, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.sm },
        lines: { gap: 2 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });

export interface RefineDoneCardProps {
    turn: Extract<RefineTurn, { kind: 'done' }>;
    superseded: boolean;
    onTest: () => void;
    onUndo: (versionId: string) => void;
}

export function RefineDoneCard({ turn, superseded, onTest, onUndo }: RefineDoneCardProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const lines = turn.changes.map((c) => changeLabel(t, c)).filter((line): line is string => Boolean(line));
    const state = undoStateOf(turn, superseded);

    return (
        <Card testID="refine-done-card">
            <View style={styles.body}>
                <Text variant="subheading">{t('agent_studio.refine.done_title', 'Done')}</Text>
                {lines.length === 0 ? (
                    <Text variant="caption" tone="secondary">
                        {t('agent_studio.refine.done_nothing', 'Nothing changed — the agent already worked that way.')}
                    </Text>
                ) : (
                    <View style={styles.lines}>
                        {lines.map((line) => (
                            <Text key={line} variant="caption" tone="secondary">
                                {`· ${line}`}
                            </Text>
                        ))}
                    </View>
                )}
                <View style={styles.actions}>
                    <Button label={t('agent_studio.refine.test_cta', 'Test with a question')} iconName="FlaskConical" size="sm" variant="secondary" onPress={onTest} />
                    <Button
                        label={undoLabel(t, state)}
                        size="sm"
                        variant="secondary"
                        loading={state === 'busy'}
                        disabled={state !== 'idle'}
                        onPress={() => {
                            if (state === 'idle' && turn.undoVersionId) onUndo(turn.undoVersionId);
                        }}
                        testID="refine-done-undo"
                    />
                </View>
                {turn.undo === 'failed' ? (
                    <Text variant="caption" tone="error">
                        {t('agent_studio.refine.undo_failed', 'Undo failed — the agent was left as it is.')}
                    </Text>
                ) : null}
            </View>
        </Card>
    );
}

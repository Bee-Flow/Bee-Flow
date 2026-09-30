/**
 * The turn the builder is streaming, at the foot of the conversation: what
 * it is doing (reading, typing a tool call, the narrator's gloss), its
 * answer so far, what it did. Once the turn is over its words join the
 * transcript and only the outcome stays here: a turn that failed says why
 * (and whether sending again is safe), and a turn that changed the flow
 * offers to take it all back — one undo, while nothing was edited since —
 * and to show the findings it left.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { BuilderTurn } from '@/features/flow-editor/api';
import { useDraftState } from '@/features/flow-editor/hooks';
import type { DraftStore } from '@/features/flow-editor/state';
import { useTurn, type TurnSource } from '@/shared/stream';
import { Banner, Button, Spinner, Text } from '@/shared/ui';

import type { AppLabel } from './activity';
import { AiMessage } from './AiMessage';
import { turnActivity, turnOutcome, turnProblem, turnStatus } from './turnModel';

const makeStyles = (theme: Theme) => ({
    status: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs } satisfies ViewStyle,
    footer: { gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm } satisfies ViewStyle,
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
});

function Outcome({ turn, store, onFindings }: { turn: BuilderTurn; store: DraftStore; onFindings: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    // The AI's last draft is still what is on screen: undo takes the whole turn back.
    const untouched = useDraftState(store, (s) => !!turn.draft && s.definition === turn.draft && s.canUndo && !s.locked);
    const outcome = turnOutcome(turn);
    const problem = turnProblem(turn, t);
    const findings = outcome.errors + outcome.warnings;
    if (!problem && !outcome.drafts) return null;
    return (
        <View style={styles.footer} testID="ai-outcome">
            {problem ? <Banner tone={problem.retry ? 'warning' : 'error'}>{problem.text}</Banner> : null}
            {outcome.drafts ? (
                <View style={styles.actions}>
                    {untouched ? (
                        <Button size="sm" variant="secondary" iconName="Undo2" label={t('mobile.flow.ai.undo_turn', 'Undo the AI’s changes')} onPress={() => store.getState().undo()} testID="ai-undo" />
                    ) : null}
                    {findings ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            iconName={outcome.errors ? 'CircleAlert' : 'TriangleAlert'}
                            label={t('mobile.flow.ai.findings', 'Findings: {n}', { n: findings })}
                            onPress={onFindings}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

export interface LiveTurnProps {
    turn: TurnSource<BuilderTurn>;
    streaming: boolean;
    store: DraftStore;
    onFindings: () => void;
    appLabel?: AppLabel;
}

export function LiveTurn({ turn: source, streaming, store, onFindings, appLabel }: LiveTurnProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const turn = useTurn(source, (s) => s);
    if (!streaming && !turn.done) return null;
    if (!streaming) return <Outcome turn={turn} store={store} onFindings={onFindings} />;
    const status = turnStatus(turn, t);
    return (
        <View testID="ai-live">
            <AiMessage role="assistant" content={turn.text} activity={turnActivity(turn, t, appLabel)} running />
            {status ? (
                <View style={styles.status} accessibilityLiveRegion="polite">
                    <Spinner />
                    <Text variant="caption" tone="secondary" numberOfLines={2}>{status}</Text>
                </View>
            ) : null}
        </View>
    );
}

/**
 * The pause between phases — the web's HandoffCard, docked under the stage
 * so what landed stays in view. Three faces:
 *   awaiting     "Phase n of N landed", the summary, then the next phase's
 *                brief (read, or edited) or one line about it; Continue (or
 *                Finish), Skip the next phase, Stop.
 *   failed       what went wrong; Retry, Skip (never the table), Stop.
 *   needs_input  a builder phase nobody is driving here (it runs on a
 *                computer): Mark as done once its automation or app exists,
 *                Skip, Stop.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Text } from '@/shared/ui';

import { BriefBox } from './BriefBox';
import { canMarkDone, hasEditableBrief, nextWords, type HandoffFace } from '../model/handoff';
import { kindOf } from '../model/phaseMachine';
import { errorText, phaseLabel } from '../model/playbookView';
import type { Phase } from '../model/types';

export interface HandoffActions {
    onContinue: (brief: string | undefined) => void;
    onSkipNext: () => void;
    onRetry: () => void;
    onSkip: () => void;
    onMarkDone: () => void;
    onStop: () => void;
}

interface Props {
    face: HandoffFace;
    phase: Phase;
    next: Phase | null;
    position: { index: number; total: number };
    busy: boolean;
    actions: HandoffActions;
}

/** The brief box's text: the server's, until the person types — and a new server brief wins again. */
function useBrief(serverBrief: string): [string, (text: string) => void] {
    const [state, setState] = useState({ server: serverBrief, text: serverBrief });
    if (state.server !== serverBrief) {
        setState({ server: serverBrief, text: serverBrief });
        return [serverBrief, (text) => setState({ server: serverBrief, text })];
    }
    return [state.text, (text) => setState({ server: serverBrief, text })];
}

function Awaiting({ phase, next, position, busy, actions }: Omit<Props, 'face'>) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const editable = hasEditableBrief(next);
    const [brief, setBrief] = useBrief(next?.brief ?? '');
    return (
        <>
            <Text variant="subheading">{`${t('playbooks.handoff.title', 'Phase {n} of {total} landed', { n: position.index + 1, total: position.total })} — ${phaseLabel(phase, t)}`}</Text>
            {phase.summary ? <Text variant="caption" tone="secondary">{phase.summary}</Text> : null}
            {next && editable ? (
                <BriefBox label={t('playbooks.handoff.next_brief', 'Next: {phase} — the brief the AI gets (edit if you like)', { phase: phaseLabel(next, t) })} brief={next.brief ?? ''} value={brief} onChange={setBrief} />
            ) : (
                <Text variant="caption" tone="secondary" testID="playbook-next-note">
                    {next ? nextWords(next, t) : t('playbooks.handoff.last', 'This was the last phase — finish to see the result.')}
                </Text>
            )}
            <View style={styles.actions}>
                <Button
                    label={next ? t('playbooks.handoff.continue', 'Continue') : t('playbooks.handoff.finish', 'Finish')}
                    iconName="ArrowRight"
                    disabled={busy}
                    onPress={() => actions.onContinue(editable && brief !== next?.brief ? brief : undefined)}
                    testID="playbook-continue"
                />
                {next && kindOf(next) !== 'table' ? (
                    <Button variant="secondary" disabled={busy} label={t('playbooks.handoff.skip_next', 'Skip {phase}', { phase: phaseLabel(next, t) })} onPress={actions.onSkipNext} testID="playbook-skip-next" />
                ) : null}
            </View>
        </>
    );
}

export function HandoffCard({ face, phase, next, position, busy, actions }: Props) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const skippable = kindOf(phase) !== 'table';
    return (
        <Card style={styles.card} testID="playbook-handoff">
            {face === 'awaiting' ? <Awaiting phase={phase} next={next} position={position} busy={busy} actions={actions} /> : null}
            {face === 'failed' ? (
                <>
                    <Text variant="subheading" tone="error">{`${t('playbooks.handoff.failed_title', 'Phase {n} did not land', { n: position.index + 1 })} — ${phaseLabel(phase, t)}`}</Text>
                    {phase.error ? <Text variant="caption" tone="secondary">{errorText(phase.error, t)}</Text> : null}
                    <Button label={t('playbooks.handoff.retry', 'Retry')} iconName="RotateCcw" disabled={busy} onPress={actions.onRetry} testID="playbook-retry" />
                </>
            ) : null}
            {face === 'needs_input' ? (
                <>
                    <Text variant="subheading">{t('mobile.playbooks.handoff.builder_title_computer', 'This phase is being built on a computer')}</Text>
                    <Text variant="caption" tone="secondary">
                        {t('mobile.playbooks.handoff.builder_body', 'When what the builder made is enough, mark the phase done. Or skip it and go on without it.')}
                    </Text>
                    {canMarkDone(phase) ? (
                        <Button label={t('playbooks.handoff.mark_done', 'Mark as done')} iconName="CircleCheck" disabled={busy} onPress={actions.onMarkDone} testID="playbook-mark-done" />
                    ) : null}
                </>
            ) : null}
            <View style={styles.actions}>
                {face !== 'awaiting' && skippable ? (
                    <Button variant="secondary" disabled={busy} label={t('playbooks.handoff.skip', 'Skip this phase')} onPress={actions.onSkip} testID="playbook-skip" />
                ) : null}
                <Button variant="ghost" iconName="Square" disabled={busy} label={t('playbooks.handoff.stop', 'Stop')} onPress={actions.onStop} testID="playbook-stop" />
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    card: { gap: theme.spacing[2.5] },
    actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing[2] },
});

/**
 * What one phase did — the web's PhaseInspector, as a sheet: what landed,
 * what went wrong, what it made (with doors to it), how long it took, the
 * brief it worked from, and the two ways past a phase that did not work.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Sheet, Text } from '@/shared/ui';

import { canRetry, canSkip } from '../model/phaseMachine';
import { errorText, phaseDuration, phaseFact, phaseLabel, phaseLinks, type PhaseLink } from '../model/playbookView';
import type { Phase } from '../model/types';

/** Each door opens a screen in this app, so its glyph is the thing's kind — never "external". */
const LINK_ICON = { automation: 'Workflow', app: 'AppWindow', datatable: 'Table' } as const;

function linkLabel(link: PhaseLink, t: ReturnType<typeof useTranslation>): string {
    if (link.kind === 'automation') return t('playbooks.done.automation', 'Automation');
    if (link.kind === 'app') return t('playbooks.done.app', 'App');
    return t('playbooks.done.table', 'Table');
}

/** A label over its text — the inspector's facts are sentences, not key/value pairs. */
function Fact({ label, value }: { label: string; value: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.fact}>
            <Text variant="label" tone="tertiary">
                {label}
            </Text>
            <Text variant="caption" selectable>
                {value}
            </Text>
        </View>
    );
}

export function PhaseSheet({
    phase,
    busy,
    onClose,
    onRetry,
    onSkip,
}: {
    phase: Phase | null;
    busy: boolean;
    onClose: () => void;
    onRetry: (key: string) => void;
    onSkip: (key: string) => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    if (!phase) return null;
    const took = phaseDuration(phase);
    const fact = phaseFact(phase, t);
    const untouched = phase.status === 'pending' || phase.status === 'ready';
    const open = (link: PhaseLink) => {
        onClose();
        router.push(link.href);
    };
    return (
        <Sheet visible onClose={onClose} title={phaseLabel(phase, t)} subtitle={t('playbooks.inspect.title', 'What this phase did')}>
            {untouched ? <Text variant="caption" tone="secondary">{t('playbooks.inspect.empty', 'This phase has not run yet.')}</Text> : null}
            {phase.summary ? <Fact label={t('playbooks.inspect.summary', 'What landed')} value={phase.summary} /> : null}
            {phase.error ? <Fact label={t('playbooks.inspect.error', 'What went wrong')} value={errorText(phase.error, t)} /> : null}
            {fact ? <Fact label={t('playbooks.inspect.made', 'What it made')} value={fact} /> : null}
            {took ? <Text variant="caption" tone="secondary">{t('playbooks.inspect.took', 'Took {time}', { time: took })}</Text> : null}
            {phase.brief ? <Fact label={t('playbooks.inspect.brief', 'The brief the AI works from')} value={phase.brief} /> : null}
            {phase.status === 'running' ? (
                <Text variant="caption" tone="tertiary">
                    {t('playbooks.inspect.stuck', 'Taking too long? Skip it, or Stop and resume — resuming fails whatever is still running.')}
                </Text>
            ) : null}
            {phaseLinks(phase).map((link) => (
                <Button key={link.kind} variant="secondary" size="sm" iconName={LINK_ICON[link.kind]} label={`${t('playbooks.done.open', 'Open')} · ${linkLabel(link, t)}`} onPress={() => open(link)} />
            ))}
            {canRetry(phase) ? <Button label={t('playbooks.handoff.retry', 'Retry')} iconName="RotateCcw" disabled={busy} onPress={() => onRetry(phase.key)} /> : null}
            {canSkip(phase) ? <Button variant="secondary" label={t('playbooks.handoff.skip', 'Skip this phase')} disabled={busy} onPress={() => onSkip(phase.key)} testID="playbook-inspect-skip" /> : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    fact: { gap: theme.spacing[0.5], paddingVertical: theme.spacing[1] },
});

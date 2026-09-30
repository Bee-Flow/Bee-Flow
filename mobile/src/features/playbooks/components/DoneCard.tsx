/**
 * The end of the film — the web's DoneCard: what landed, phase by phase, how
 * long it took, and the doors to what was built. A stopped playbook says it
 * stopped and offers Resume (resuming fails whatever was mid-build, so Retry
 * or Skip come back for it).
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, KindTile, Text } from '@/shared/ui';

import { progress } from '../model/phaseMachine';
import { phaseFact, phaseKind, phaseLabel, phaseLinks, totalElapsed } from '../model/playbookView';
import type { Phase, Playbook } from '../model/types';

function outcome(phase: Phase, t: TranslateFn): string {
    if (phase.status === 'skipped') return t('playbooks.done.skipped', 'skipped');
    if (phase.status === 'locked') return t('playbooks.done.locked', 'not on this plan');
    if (phase.status === 'failed' && phase.error === 'interrupted') return t('playbooks.done.interrupted', 'stopped mid-build — resume to retry it');
    if (phase.status !== 'done' && phase.status !== 'awaiting') return t('playbooks.done.not_reached', 'not reached');
    return phaseFact(phase, t) ?? t('playbooks.state.done', 'Done');
}

function Landed({ phase }: { phase: Phase }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.line}>
            <KindTile kind={phaseKind(phase)} size={28} />
            <View style={styles.grow}>
                <Text variant="caption" weight="semibold">
                    {phaseLabel(phase, t)}
                </Text>
                <Text variant="label" tone="tertiary">
                    {outcome(phase, t)}
                </Text>
            </View>
            {phaseLinks(phase).slice(0, 1).map((link) => (
                <Button
                    key={link.kind}
                    size="sm"
                    variant="ghost"
                    label={t('playbooks.done.open', 'Open')}
                    onPress={() => router.push(link.href)}
                />
            ))}
        </View>
    );
}

export function DoneCard({ playbook, busy, onResume }: { playbook: Playbook; busy: boolean; onResume: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const stopped = playbook.status === 'stopped';
    const count = progress(playbook.phases);
    const took = totalElapsed(playbook.phases);
    return (
        <Card style={styles.card} testID="playbook-done">
            <Text variant="heading">
                {stopped ? t('playbooks.done.stopped_title', 'Stopped — this is what landed') : t('playbooks.done.title', '{title} is ready', { title: playbook.title })}
            </Text>
            <Text variant="caption" tone="secondary">
                {[t('playbooks.done.phases', '{n} of {total} phases built', { n: count.done, total: count.total }), took ? t('playbooks.done.elapsed', 'in {time}', { time: took }) : null].filter(Boolean).join(' ')}
            </Text>
            {playbook.phases.map((phase) => (
                <Landed key={phase.key} phase={phase} />
            ))}
            <View style={styles.actions}>
                {stopped ? <Button label={t('playbooks.done.resume', 'Resume')} iconName="Play" loading={busy} onPress={onResume} testID="playbook-resume" /> : null}
                <Button variant="secondary" label={t('playbooks.done.back', 'Back to playbooks')} onPress={() => router.back()} />
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    card: { gap: theme.spacing[3] },
    line: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[3] },
    grow: { flex: 1 },
    actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing[2] },
});

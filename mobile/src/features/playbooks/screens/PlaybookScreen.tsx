/**
 * One open playbook — the web's PlaybookRun for a phone. The header is the
 * Studio object header (kind tile, name, status, Stop, the overflow menu) with
 * two sections: the STAGE (where the film is, the phase in hand, and the
 * handoff card docked under it whenever the AI has stopped for the person)
 * and the PHASES (the rail, each row opening what that phase did).
 *
 * The page polls while the server runs a phase (hooks/queries usePlaybook) and
 * starts the phases the phone can see through on its own (useAutoStart).
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryScreen } from '@/shared/patterns';
import { ActionMenu, Badge, Banner, Button, Icon, IconButton, ObjectHeader } from '@/shared/ui';

import { DoneCard } from '../components/DoneCard';
import { HandoffCard } from '../components/HandoffCard';
import { PhaseList } from '../components/PhaseList';
import { PhaseSheet } from '../components/PhaseSheet';
import { Stage } from '../components/Stage';
import { StageBar } from '../components/StageBar';
import { usePlaybookRun } from '../hooks/usePlaybookRun';
import { playbookStatus } from '../model/playbookView';
import type { Playbook } from '../model/types';
import { VIEW_TONE_BADGE } from '../model/viewTone';

type Tab = 'stage' | 'phases';

function StageTab({ run }: { run: ReturnType<typeof usePlaybookRun> }) {
    const { playbook, onStage, complete, handoff, actions, next } = run;
    if (!playbook) return null;
    if (complete) return <DoneCard playbook={playbook} busy={actions.busy} onResume={() => void actions.dispatch({ type: 'resume' })} />;
    return (
        <>
            {onStage ? <Stage key={`${onStage.key}:${onStage.attempt}`} playbook={playbook} phase={onStage} dispatch={actions.dispatch} /> : null}
            {handoff.face && run.active ? (
                <HandoffCard
                    key={`${run.active.key}:${run.active.status}:${next?.key ?? ''}`}
                    face={handoff.face}
                    phase={run.active}
                    next={handoff.face === 'awaiting' ? next : null}
                    position={handoff.position}
                    busy={actions.busy}
                    actions={handoff.actions}
                />
            ) : null}
        </>
    );
}

export function PlaybookScreen({ id }: { id: string }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const run = usePlaybookRun(id);
    const [tab, setTab] = useState<Tab>('stage');
    const [menu, setMenu] = useState(false);
    const [inspect, setInspect] = useState<string | null>(null);
    const [seenConflicts, setSeenConflicts] = useState(0);
    const { actions } = run;
    const inspected = run.phases.find((p) => p.key === inspect) ?? null;

    const header = (pb: Playbook | undefined) => {
        const status = pb ? playbookStatus(pb, t) : null;
        return (
            <ObjectHeader<Tab>
                kind="playbook"
                title={pb?.title ?? ''}
                backLabel={t('playbooks.bar.back', 'Back to playbooks')}
                status={status ? <Badge label={status.text} tone={VIEW_TONE_BADGE[status.tone]} /> : null}
                primary={pb && !run.complete ? <Button size="sm" variant="secondary" iconName="Square" label={t('playbooks.bar.stop', 'Stop')} disabled={actions.busy} onPress={() => void run.stop()} testID="playbook-bar-stop" /> : null}
                extras={<IconButton icon={<Icon name="EllipsisVertical" size={20} color={styles.glyph.color} />} accessibilityLabel={t('mobile.playbooks.more', 'More')} onPress={() => setMenu(true)} />}
                tabs={[
                    { id: 'stage', label: t('mobile.playbooks.tab.stage', 'Now') },
                    { id: 'phases', label: t('playbooks.rail.aria', 'Phases') },
                ]}
                activeTab={tab}
                onTab={setTab}
            />
        );
    };

    return (
        <>
            <QueryScreen query={run.query} header={header} screen={{ edges: ['bottom'] }}>
                {(pb) => (
                    <View style={styles.body}>
                        <StageBar status={pb.status} complete={run.complete} onStage={run.onStage} index={run.index} total={pb.phases.length} />
                        {actions.conflicts > seenConflicts ? (
                            <Banner tone="warning" action={<Button size="sm" variant="ghost" label={t('playbooks.inspect.close', 'Close')} onPress={() => setSeenConflicts(actions.conflicts)} />}>
                                {t('playbooks.err_conflict', 'This playbook changed elsewhere — showing the latest state.')}
                            </Banner>
                        ) : actions.error ? (
                            <Banner tone="error" action={<Button size="sm" variant="ghost" label={t('playbooks.reload', 'Reload')} onPress={() => { actions.clearError(); void run.query.refetch(); }} />}>
                                {describeError(actions.error).message}
                            </Banner>
                        ) : null}
                        {tab === 'stage' ? <StageTab run={run} /> : <PhaseList phases={pb.phases} activeKey={run.active?.key ?? null} onOpen={setInspect} />}
                    </View>
                )}
            </QueryScreen>
            <PhaseSheet
                phase={inspected}
                busy={actions.busy}
                onClose={() => setInspect(null)}
                onRetry={(key) => { setInspect(null); void actions.dispatch({ type: 'retry', key }); }}
                onSkip={(key) => { setInspect(null); void actions.dispatch({ type: 'skip', key }); }}
            />
            <ActionMenu
                visible={menu}
                onClose={() => setMenu(false)}
                title={run.playbook?.title}
                items={[
                    { id: 'delete', label: t('common.delete', 'Delete'), icon: 'Trash2', destructive: true, onPress: () => void run.onDelete().then((gone) => gone && router.back()) },
                ]}
            />
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing[3], paddingTop: theme.spacing[3] },
    glyph: { color: theme.colors.textSecondary },
});

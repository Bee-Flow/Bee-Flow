/**
 * One open playbook, as the run screen needs it — the web's PlaybookRun
 * minus its drawing: the phase on stage, the one after it, whether the film
 * is over, and every press the screen offers (continue, skip the next phase,
 * retry, skip, mark as done, stop, resume, delete), each one wire through
 * usePlaybookActions. The server decides; this only asks.
 */

import { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

import { useDeletePlaybook } from './mutations';
import { usePlaybook } from './queries';
import { useAutoStart } from './useAutoStart';
import { usePlaybookActions } from './usePlaybookActions';
import { handoffFace, markDoneArtifacts } from '../model/handoff';
import { canSkip, isComplete, nextActionable, nextPending } from '../model/phaseMachine';
import type { Phase } from '../model/types';

export function usePlaybookRun(id: string) {
    const t = useTranslation();
    const confirm = useConfirm();
    const query = usePlaybook(id);
    const actions = usePlaybookActions(id);
    const remove = useDeletePlaybook();
    const playbook = query.data ?? null;
    const phases = playbook?.phases ?? [];
    const active = nextActionable(phases);
    // Between an optimistic "done" and the server's answer no phase is
    // actionable; the one that was stays on stage instead of a blank.
    const [lastActive, setLastActive] = useState<Phase | null>(null);
    if (active && active !== lastActive) setLastActive(active);
    const onStage = active ?? lastActive;
    const complete = !!playbook && (playbook.status !== 'active' || isComplete(phases));
    const next = active ? nextPending(phases, active.key) : null;
    const index = onStage ? phases.findIndex((p) => p.key === onStage.key) : -1;
    useAutoStart(playbook, active, actions.dispatch);

    const stop = async () => {
        const ok = await confirm({
            title: t('playbooks.stop.title', 'Stop this playbook?'),
            message: t('playbooks.stop.note', 'What has landed stays — the table, the automation draft, the app. A builder turn still running finishes on its own.'),
            confirmLabel: t('playbooks.stop.confirm', 'Stop'),
        });
        if (ok) await actions.dispatch({ type: 'stop' });
    };
    const onContinue = (brief: string | undefined) => {
        if (!active) return;
        void actions.dispatch({ type: 'continue', key: active.key, nextKey: next?.key ?? null, brief: next ? brief : undefined });
    };
    // Confirm this phase, then skip the one that became ready.
    const onSkipNext = async () => {
        if (!active || !next) return;
        const pb = await actions.dispatch({ type: 'continue', key: active.key, nextKey: null });
        const fresh = pb?.status === 'active' ? pb.phases.find((p) => p.key === next.key) : null;
        if (pb && fresh && canSkip(fresh)) await actions.dispatch({ type: 'skip', key: next.key }, pb);
    };
    const onDelete = async (): Promise<boolean> => {
        const ok = await confirm({
            title: t('mobile.playbooks.delete_title', 'Delete this playbook?'),
            message: t('mobile.playbooks.delete_note', 'Only the playbook goes. The table, the automation and the app it built stay where they are.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (!ok) return false;
        await remove.mutateAsync(id);
        return true;
    };
    const handoff = {
        face: handoffFace(active, complete),
        position: { index, total: phases.length },
        actions: {
            onContinue,
            onSkipNext: () => void onSkipNext(),
            onRetry: () => active && void actions.dispatch({ type: 'retry', key: active.key }),
            onSkip: () => active && void actions.dispatch({ type: 'skip', key: active.key }),
            onMarkDone: () => active && void actions.dispatch({ type: 'markDone', key: active.key, artifacts: markDoneArtifacts(active) }),
            onStop: () => void stop(),
        },
    };
    return { query, playbook, phases, active, onStage, next, complete, index, handoff, actions, stop, onDelete };
}

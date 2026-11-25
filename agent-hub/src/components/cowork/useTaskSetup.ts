/**
 * Right after a new task is started: Cowork sets up its steps and tests them once, nothing sent, with the planner and
 * the try-out the server already has (POST /api/cowork/:id/plan/make, ../../api/coworkPlanMake.ts). The home shows it
 * as two phases, "Setting up the steps" and "Testing once, nothing is sent" (./CoworkHomeComposer.tsx), and the task's
 * status says Testing meanwhile. It ends in a "check the steps" card under Needs you: every Cowork read is read again.
 *
 * It never ends silently in "the AI does it each time". A task that was started to get steps (its `setup.steps` is
 * 'wanted', server usecases/coworkSetup.mts) waits when the set-up fails, and when the page is left before it finished
 * (the request is aborted, and the server notes that): a card under Needs you then says so and asks what to do. Only a
 * task whose organisation has no fixed steps is the AI's from the start, and its confirmation said so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { makeCoworkPlan } from '@/api/coworkPlanMake';
import { apiJson } from '@/api/typedRequest';
import type { PlanMakeProgress } from '@/api/coworkPlan.types';
import type { CoworkItem } from '@/api/cowork.types';
import { useTranslation } from '@/hooks/useTranslation';

export interface TaskSetup { id: string; title: string; phase: PlanMakeProgress['phase'] | 'checking' }

/** The task to set up: the new task itself, or just its id and name (it is then read first). */
export type TaskToSetUp = Pick<CoworkItem, 'id' | 'title'> & Partial<Pick<CoworkItem, 'setup'>>;

/** Does the task wait for its steps? Read from the task itself when the caller did not hand its set-up in. */
async function wantsSteps(task: TaskToSetUp): Promise<boolean | null> {
    if (task.setup !== undefined) return task.setup?.steps === 'wanted';
    try {
        const item = await apiJson<'GET /api/cowork/{id}', CoworkItem>('GET /api/cowork/{id}', { params: { id: task.id } });
        return item.setup?.steps === 'wanted';
    } catch {
        return null;
    }
}

export default function useTaskSetup(onDone: (message: string, task: TaskToSetUp) => void) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const [setup, setSetup] = useState<TaskSetup | null>(null);
    const running = useRef<AbortController | null>(null);
    useEffect(() => () => running.current?.abort(), []);

    const begin = useCallback(async (task: TaskToSetUp) => {
        running.current?.abort();
        const control = new AbortController();
        running.current = control;
        const settle = async (message: string) => {
            await client.invalidateQueries({ queryKey: ['cowork'] });
            if (control.signal.aborted) return;
            running.current = null;
            setSetup(null);
            onDone(message, task);
        };
        setSetup({ id: task.id, title: task.title, phase: 'checking' });
        const wanted = await wantsSteps(task);
        if (control.signal.aborted) return;
        if (wanted === null) {
            await settle(t('cowork_home.activity.unknown', 'Task created. Open it to check the setup.'));
            return;
        }
        if (!wanted) {
            if (!control.signal.aborted) await settle(t('cowork_home.setup.ai', 'Started. The AI works this task out on every run.'));
            return;
        }
        setSetup({ id: task.id, title: task.title, phase: 'thinking' });
        const progress = (p: PlanMakeProgress) => setSetup((s) => (s?.id === task.id && !control.signal.aborted ? { ...s, phase: p.phase } : s));
        let ready = false;
        try {
            const outcome = await makeCoworkPlan(task.id, { signal: control.signal, onProgress: progress });
            ready = outcome.error === null && !outcome.state?.tried?.blocksApproval;
        } catch {
            if (control.signal.aborted) return;
        }
        if (control.signal.aborted) return;
        await settle(ready
            ? t('cowork_home.activity.ready', 'Your task is ready for review.')
            : t('cowork_home.activity.attention', 'Setup stopped. Open the task to see what needs your attention.'));
    }, [client, onDone, t]);

    return { setup, begin };
}

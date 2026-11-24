/**
 * Right after a new task is started: Cowork sets up its steps and tests them once, nothing sent, with the planner and
 * the try-out the server already has (POST /api/cowork/:id/plan/make, ../../api/coworkPlanMake.ts). The home shows it
 * as two phases, "Setting up the steps" and "Testing once, nothing is sent" (./CoworkHomeComposer.tsx), and the task's
 * status says Testing meanwhile. It ends in a "check the steps" card under Needs you: every Cowork read is read again.
 *
 * Leaving the page stops it (the request is aborted); the task stays, and runs with the AI until it has steps.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { makeCoworkPlan } from '@/api/coworkPlanMake';
import type { PlanMakeProgress } from '@/api/coworkPlan.types';
import { useTranslation } from '@/hooks/useTranslation';

export interface TaskSetup { id: string; title: string; phase: number }

/** Drafting and saving are the first phase; trying and repairing what the try-out found, the second. */
const phaseOf = (progress: PlanMakeProgress): number => (progress.phase === 'trying' || progress.phase === 'repairing' ? 1 : 0);

export default function useTaskSetup(onDone: (message: string) => void) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const [setup, setSetup] = useState<TaskSetup | null>(null);
    const running = useRef<AbortController | null>(null);
    useEffect(() => () => running.current?.abort(), []);

    const begin = useCallback(async (task: { id: string; title: string }) => {
        running.current?.abort();
        const control = new AbortController();
        running.current = control;
        setSetup({ id: task.id, title: task.title, phase: 0 });
        const progress = (p: PlanMakeProgress) => setSetup((s) => (s?.id === task.id ? { ...s, phase: Math.max(s.phase, phaseOf(p)) } : s));
        let message: string;
        try {
            const outcome = await makeCoworkPlan(task.id, { signal: control.signal, onProgress: progress });
            message = outcome.error === null
                ? t('cowork_home.setup.ready', 'The steps are ready and tested. Check them under Needs you.')
                : t('cowork_home.setup.failed', 'Cowork could not set up fixed steps, so the AI does this task each time. {reason}', { reason: outcome.error });
        } catch {
            if (control.signal.aborted) return;
            message = t('cowork_home.setup.failed', 'Cowork could not set up fixed steps, so the AI does this task each time. {reason}', { reason: '' });
        }
        running.current = null;
        setSetup(null);
        await client.invalidateQueries({ queryKey: ['cowork'] });
        onDone(message.trim());
    }, [client, onDone, t]);

    return { setup, begin };
}

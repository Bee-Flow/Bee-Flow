import type { TranslateFn } from '@/hooks/useTranslation';
import type { TaskStep } from './task/coworkTaskModel';
import type { OrbStep } from '@/api/coworkPlan.types';

/** The weekly digest of the tour as a plan: the orb draws `flow`, the step rail lists `steps`. */
export function introPlan(t: TranslateFn) {
    const flow: (OrbStep & {title: string})[] = [
        {id: 'week', type: 'code', kind: 'fixed', title: t("cowork_home.tour.step_week", "Look back one week")},
        {id: 'read', type: 'form', app: 'meeting-notes', kind: 'fixed', title: t("cowork_home.tour.step_read", "Read the meeting notes")},
        {id: 'check', type: 'condition', kind: 'fixed', title: t("cowork_home.tour.step_check", "Skip empty notes")},
        {id: 'write', type: 'ai_step', kind: 'ai', title: t("cowork_home.tour.step_write", "Write the digest")},
        {id: 'result', type: 'notification', kind: 'deliver', title: t("cowork_home.tour.step_result", "Have it ready for you")},
    ];
    const steps: TaskStep[] = flow.map(step => ({
        ...step, app: step.app ? "Meeting Notes" : null, integrationId: step.app ?? null, helper: false, changed: false, to: null,
        sort: step.kind === 'ai' ? 'ai' : step.kind === 'deliver' ? 'send' : 'read',
    }));
    return {flow, steps};
}

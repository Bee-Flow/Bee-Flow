import type { TranslateFn } from '@/hooks/useTranslation';
import type { TaskStep } from './task/coworkTaskModel';
import type { OrbStep } from '@/api/coworkPlan.types';

export function introPlan(t: TranslateFn, intake: boolean) {
    const flow: (OrbStep & {title: string})[] = intake ? [
        {id: 'pick', type: 'form', kind: 'ask', title: t("cowork_home.story.pick_title", "Find a meeting in Meeting Notes")},
        {id: 'fetch', type: 'form', app: 'meeting-notes', kind: 'fixed', title: t("cowork_home.story.fetch_title", "Retrieve the selected Meeting Notes record")},
        {id: 'store', type: 'datatable', kind: 'fixed', title: t("cowork_home.story.store_title", "Save the summary to the source table")},
    ] : [
        {id: 'period', type: 'code', kind: 'fixed', title: t("cowork_home.story.step_period", "Calculate last week’s date range")},
        {id: 'read', type: 'datatable', kind: 'fixed', title: t("cowork_home.story.step_read", "Read the Meeting Notes source table")},
        {id: 'clean', type: 'code', kind: 'fixed', title: t("cowork_home.story.step_clean", "Filter by date and deduplicate note IDs")},
        {id: 'check', type: 'condition', kind: 'fixed', title: t("cowork_home.story.step_check", "Check for usable summaries")},
        {id: 'write', type: 'ai_step', kind: 'ai', title: t("cowork_home.story.step_write", "Extract decisions, owners and deadlines")},
        {id: 'result', type: 'notification', kind: 'deliver', title: t("cowork_home.story.step_result", "Show the digest in Cowork")},
    ];
    const steps: TaskStep[] = flow.map(step => ({
        ...step, app: step.app ? "Meeting Notes" : null, integrationId: step.app ?? null, helper: false, changed: false, to: null,
        sort: step.kind === 'ask' ? 'ask' : step.id === 'store' ? 'change' : step.kind === 'ai' ? 'ai' : step.kind === 'deliver' ? 'send' : 'read',
    }));
    return {flow, steps};
}

import { ActivityLine } from '../CoworkActivity';
import { Check, Circle, CircleAlert, Play } from 'lucide-react';
import type { PlanTryState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import CoworkOrb from '../CoworkOrb';
import { plainStepTitle } from '../coworkOverviewModel';
import { inRunOrder } from './coworkTaskModel';

interface Props { state: PlanTryState | null; runOrder?: string[]; t: TranslateFn }

function stateLabel(status: string, t: TranslateFn) {
    switch (status) {
        case 'running': return t('cowork_task.test.active', 'Testing');
        case 'queued':
        case 'pending': return t('cowork_task.test.waiting', 'Waiting');
        case 'error':
        case 'failed': return t('cowork_task.trace.failed', 'Failed');
        case 'success': return t('cowork_task.trace.done', 'Done');
        case 'not_reached': return t('cowork_task.trace.skipped', 'Not reached');
        default: return status;
    }
}

export default function CoworkTestProgress({ state, runOrder, t }: Props) {
    const steps = inRunOrder(state?.steps ?? [], runOrder);
    const current = steps.findLast(step => step.status === 'running');
    const summary = current
        ? t('cowork_task.test.current', 'I’m testing step {number} of {total}: {title}', {
            number: steps.indexOf(current) + 1, total: steps.length, title: plainStepTitle(current, t),
        })
        : t('cowork_task.test.wait', 'I’m waiting for the next test step.');
    return <section className="cowork-activity">
        <CoworkOrb work={{ action: 'testing', apps: [current?.app], stepType: current?.type, flow: steps, focus: current ? steps.indexOf(current) : undefined }} activity={summary} tone={current?.kind === 'ai' ? 'thinking' : 'executing'} />
        <h3 className="cowork-activity-current" aria-live="polite" aria-atomic="true"><ActivityLine message={summary} /></h3>
        {steps.length > 0 && <details className="mt-2 w-full text-left"><summary className="mx-auto w-fit cursor-pointer text-[13px] text-[var(--text-secondary)]">{t('cowork_task.flow.details', 'Details')}</summary>
        <ol className="m-0 mt-2 list-none p-0">
            {steps.map(step => {
                const active = step.status === 'running';
                const Icon = ({ success: Check, running: Play, failed: CircleAlert, error: CircleAlert })[step.status] ?? Circle;
                return <li key={step.id} aria-current={active ? 'step' : undefined}
                    className={`flex items-center gap-3 rounded-md px-2 py-2 text-[13px] ${active ? 'bg-[var(--bg-secondary)] font-semibold' : 'text-[var(--text-secondary)]'}`}>
                    <Icon aria-hidden="true" size={14} className="shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{plainStepTitle(step, t)}</span>
                    <span>{stateLabel(step.status, t)}</span>
                </li>;
            })}
        </ol></details>}
    </section>;
}

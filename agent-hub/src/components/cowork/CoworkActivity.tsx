import type { PlanMakeProgress } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import { SWAP } from './coworkMotion';

/** A single live message, updated in place as the planner reports work. */
export default function CoworkActivity({ message, title, testId }: { message: string; title?: string; testId?: string }) {
    return <div className="cowork-activity" data-testid={testId}>
        <span aria-hidden="true" className="cowork-activity-mark"><span /></span>
        <div className="min-w-0">
            {title && <p className="m-0 mb-1 break-words text-[13px] font-medium text-[var(--text-secondary)]">{title}</p>}
            <div role="status" aria-atomic="true" className="text-[16px] leading-6 font-semibold text-[var(--text-primary)]">
                <span key={message} className={SWAP}>{message}</span>
            </div>
        </div>
    </div>;
}

export function setupMessage(phase: PlanMakeProgress['phase'] | 'checking' | null, t: TranslateFn) {
    switch (phase) {
        case 'checking': return t('cowork_home.activity.checking', 'Checking task setup…');
        case 'saving': return t('cowork_home.activity.saving', 'Saving task steps…');
        case 'trying': return t('cowork_home.setup.testing', 'Testing once, nothing is sent');
        case 'repairing': return t('cowork_wiring.make.repairing', 'Fixing what the try-out found…');
        default: return t('cowork_task.live.make_think', 'Working out the steps');
    }
}

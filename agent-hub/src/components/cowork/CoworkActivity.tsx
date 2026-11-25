import type { ReactNode } from 'react';
import type { PlanMakeProgress, PlanningTestStep } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

import CoworkOrb, { type ActivityTone } from './CoworkOrb';

interface ActivityProps {
    message: string; title?: string; tone?: ActivityTone; testId?: string; children?: ReactNode;
}

export default function CoworkActivity({ message, title, tone, testId, children }: ActivityProps) {
    return <div className="cowork-activity" data-testid={testId}>
        <CoworkOrb tone={tone} activity={message} />
        <div className="cowork-activity-caption">
            {title && <p className="m-0 mb-1 break-words text-[13px] font-medium text-[var(--text-secondary)]">{title}</p>}
            <div role="status" aria-atomic="true" className="cowork-activity-current">
                <span key={message} className="cowork-activity-label">{message}</span>
            </div>
        </div>
        {children}
    </div>;
}

export function setupActivity(phase: PlanMakeProgress['phase'] | 'checking' | null, t: TranslateFn, step?: PlanningTestStep): ActivityProps {
    switch (phase) {
        case 'checking': return { message: t('cowork_home.activity.checking', 'Checking task setup…') };
        case 'saving': return { tone: 'executing', message: t('cowork_home.activity.saving', 'Saving task steps…') };
        case 'trying': return step && step.total > 0 ? {
            tone: step.kind === 'ai' ? 'thinking' : 'executing',
            message: t('cowork_task.test.current', 'Testing step {number} of {total}: {title}', { ...step }),
        } : { tone: 'executing', message: t('cowork_home.setup.testing', 'Testing once, nothing is sent') };
        case 'repairing': return { tone: 'repair', message: t('cowork_wiring.make.repairing', 'Fixing what the try-out found…') };
        case 'drafted': return { message: t('cowork_home.activity.check_draft', 'Checking the proposed steps…') };
        default: return { message: t('cowork_task.live.make_think', 'Working out the steps') };
    }
}

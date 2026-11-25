import type { ReactNode } from 'react';
import type { OrbStep, PlanMakeProgress, PlanningTestStep } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

import CoworkOrb, { type ActivityTone } from './CoworkOrb';

import type { OrbWork } from './CoworkOrbSources';

interface ActivityProps {
    work?: OrbWork; message: string; title?: string; tone?: ActivityTone; testId?: string; children?: ReactNode;
}

export default function CoworkActivity({ message, title, tone, work, testId, children }: ActivityProps) {
    return <div className="cowork-activity" data-testid={testId}>
        <CoworkOrb tone={tone} work={work} activity={message} />
        <div className="cowork-activity-caption">
            {title && <p className="m-0 mb-1 break-words text-[13px] font-medium text-[var(--text-secondary)]">{title}</p>}
            <div role="status" aria-atomic="true" className="cowork-activity-current">
                <span key={message} className="cowork-activity-label">{message}</span>
            </div>
        </div>
        {children}
    </div>;
}

export function setupActivity(phase: PlanMakeProgress['phase'] | 'checking' | null, t: TranslateFn, step?: PlanningTestStep, apps?: string[] | null, flow?: OrbStep[]): ActivityProps {
    switch (phase) {
        case 'checking': return { work: { action: 'testing', apps, flow }, message: t('cowork_home.activity.checking', 'Checking task setup…') };
        case 'saving': return { work: { action: 'saving', apps, flow }, tone: 'executing', message: t('cowork_home.activity.saving', 'Saving task steps…') };
        case 'trying': return step && step.total > 0 ? {
            work: { action: step.kind === 'ai' ? 'thinking' : 'testing', apps: step.app ? [step.app] : [], stepType: step.type, flow, focus: step.number - 1 },
            tone: step.kind === 'ai' ? 'thinking' : 'executing',
            message: t('cowork_task.test.current', 'Testing step {number} of {total}: {title}', { ...step }),
        } : { work: { action: 'testing', apps, flow }, tone: 'executing', message: t('cowork_home.setup.testing', 'Testing once, nothing is sent') };
        case 'repairing': return { work: { action: 'repair', apps, flow }, tone: 'repair', message: t('cowork_wiring.make.repairing', 'Fixing what the try-out found…') };
        case 'drafted': return { work: { action: 'creating', apps, flow }, message: t('cowork_home.activity.check_draft', 'Checking the proposed steps…') };
        default: return { work: { action: 'thinking', apps, flow }, message: t('cowork_task.live.make_think', 'Working out the steps') };
    }
}

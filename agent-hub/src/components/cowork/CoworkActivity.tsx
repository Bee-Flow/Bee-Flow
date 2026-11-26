import type { ReactNode } from 'react';
import type { OrbStep, PlanMakeProgress, PlanningTestStep } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

import CoworkOrb, { type ActivityTone } from './CoworkOrb';

import type { OrbWork } from './CoworkOrbSources';

interface ActivityProps {
    captionAbove?: boolean; work?: OrbWork; message: string; title?: string; tone?: ActivityTone; testId?: string; children?: ReactNode;
}

export function ActivityLine({message}: {message: string}) {
    return <span key={message} className="cowork-activity-label">{message}</span>;
}

export default function CoworkActivity({ message, title, tone, work, testId, children, captionAbove }: ActivityProps) {
    const caption = <div className="cowork-activity-caption">
        <div role="status" aria-label={title} aria-atomic="true" className="cowork-activity-current">
            <ActivityLine key={title} message={message} />
        </div>
    </div>;
    return <div className="cowork-activity" data-testid={testId}>
        {captionAbove && caption}
        <CoworkOrb tone={tone} work={work} activity={message} />
        {!captionAbove && caption}
        {children}
    </div>;
}

export function setupActivity(phase: PlanMakeProgress['phase'] | 'checking' | null, t: TranslateFn, step?: PlanningTestStep, apps?: string[] | null, flow?: OrbStep[]): ActivityProps {
    switch (phase) {
        case 'checking': return { work: { action: 'testing', apps, flow }, message: t('cowork_home.activity.checking', 'I’m checking how your task is set up.') };
        case 'saving': return { work: { action: 'saving', apps, flow }, tone: 'executing', message: t('cowork_home.activity.saving', 'I’m saving these steps for the trial run.') };
        case 'trying': return step && step.total > 0 ? {
            work: { action: step.kind === 'ai' ? 'thinking' : 'testing', apps: step.app ? [step.app] : [], stepType: step.type, flow, focus: step.id ? flow?.findIndex(s => s.id === step.id) : step.number - 1 },
            tone: step.kind === 'ai' ? 'thinking' : 'executing',
            message: t('cowork_task.test.current', 'I’m testing step {number} of {total}: {title}', { ...step }),
        } : { work: { action: 'testing', apps, flow }, tone: 'executing', message: t('cowork_home.setup.testing', 'I’m trying the steps once. Nothing is sent.') };
        case 'repairing': return { work: { action: 'repair', apps, flow }, tone: 'repair', message: t('cowork_wiring.make.repairing', 'I’m adjusting the steps after the trial run.') };
        case 'drafted': return { work: { action: 'creating', apps, flow }, message: t('cowork_home.activity.check_draft', 'I’m checking how the proposed steps fit together.') };
        default: return { work: { action: 'thinking', apps, flow }, message: t('cowork_task.live.make_think', 'First I’ll put the steps in order.') };
    }
}

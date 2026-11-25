import type { ReactNode } from 'react';
import type { PlanMakeProgress, PlanningTestStep } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

type Tone = 'thinking' | 'executing' | 'repair' | 'rest';
const PATH = 'M 9 17 C 28 17 32 9 50 9 S 79 22 97 18 S 125 8 143 12 S 161 17 178 14';

/** One continuous stroke follows reported milestones. Its end moves along the same curve as the ink. */
export function CoworkTrail({ position, tone = 'thinking' }: { position: number; tone?: Tone }) {
    const at = Math.min(.999, Math.max(.001, position));
    return <svg className="cowork-trail" data-tone={tone} aria-hidden="true" viewBox="-12 -12 212 49" fill="none">
        <g strokeLinecap="round">
            <path d={PATH} className="cowork-trail-base" strokeWidth="2" />
            <path d={PATH} pathLength="1" className="cowork-trail-ink" strokeWidth="2.5" strokeDasharray="1 2" strokeDashoffset={1 - at} />
            <g className="cowork-worker" strokeDasharray=".001 2" strokeDashoffset={-at}>
                <path d={PATH} pathLength="1" className="cowork-worker-field" strokeWidth="27" />
                <path d={PATH} pathLength="1" transform="translate(-3 1)" strokeWidth="12" />
                <g className="cowork-worker-petal" transform="translate(-3 -4)">
                    <path d={PATH} pathLength="1" transform="translate(-2 0)" strokeWidth="8" />
                    <path d={PATH} pathLength="1" transform="translate(3 -2)" strokeWidth="6" />
                </g>
                <path d={PATH} pathLength="1" transform="translate(4 0)" strokeWidth="8.5" />
                <path d={PATH} pathLength="1" className="cowork-worker-light" transform="translate(5 -1)" strokeWidth="2.4" />
            </g>
        </g>
    </svg>;
}

interface ActivityProps {
    message: string; position?: number; title?: string; tone?: Tone; testId?: string; children?: ReactNode;
}

export default function CoworkActivity({ message, position = 0, title, tone, testId, children }: ActivityProps) {
    return <div className="cowork-activity" data-testid={testId}>
        {title && <p className="m-0 break-words text-[13px] font-medium text-[var(--text-secondary)]">{title}</p>}
        <CoworkTrail position={position} tone={tone} />
        <div role="status" aria-atomic="true" className="text-[16px] leading-6 font-semibold text-[var(--text-primary)]">
            <span key={message} className="cowork-activity-label">{message}</span>
        </div>
        {children}
    </div>;
}

export function setupActivity(phase: PlanMakeProgress['phase'] | 'checking' | null, t: TranslateFn, step?: PlanningTestStep): ActivityProps {
    switch (phase) {
        case 'checking': return { position: 0, message: t('cowork_home.activity.checking', 'Checking task setup…') };
        case 'saving': return { tone: 'executing', position: .42, message: t('cowork_home.activity.saving', 'Saving task steps…') };
        case 'trying': return step && step.total > 0 ? {
            tone: step.kind === 'ai' ? 'thinking' : 'executing', position: .52 + .44 * step.number / step.total,
            message: t('cowork_task.test.current', 'Testing step {number} of {total}: {title}', { ...step }),
        } : { tone: 'executing', position: .52, message: t('cowork_home.setup.testing', 'Testing once, nothing is sent') };
        case 'repairing': return { position: .35, tone: 'repair', message: t('cowork_wiring.make.repairing', 'Fixing what the try-out found…') };
        case 'drafted': return { position: .28, message: t('cowork_home.activity.check_draft', 'Checking the proposed steps…') };
        default: return { position: .13, message: t('cowork_task.live.make_think', 'Working out the steps') };
    }
}

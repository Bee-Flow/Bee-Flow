/**
 * "Make a plan": Cowork drafts the plan of an item from its brief. One button; while the plan is drafted the steps
 * appear as they are added, and the drafting can be stopped. Nothing runs and nothing is approved here: what comes
 * out is the plan card, to try and to approve.
 *
 * Presentation only: the drafting comes in as props (hooks/useCoworkPlanMaker.ts does it).
 */
import { Loader2, Sparkles } from 'lucide-react';
import CoworkPlanKindTile, { KIND_FALLBACK } from './CoworkPlanKindTile';
import type { PlanMaking } from '../../hooks/useCoworkPlanMaker';
import type { TranslateFn } from '../../hooks/useTranslation';

export interface CoworkPlanMakeProps {
    t: TranslateFn;
    making: PlanMaking;
    onMake: () => void;
    onCancel: () => void;
}

const PHASE_FALLBACK: Record<NonNullable<PlanMaking['phase']>, string> = {
    thinking: 'Working out the steps…',
    drafted: 'Drafting the plan…',
    saving: 'Saving the plan…',
    trying: 'Trying the plan once, without changing or sending anything…',
    repairing: 'Fixing what the try-out found…',
};

/** The key of a phase's words: the try-out's phases have their own namespace. */
const phaseKey = (phase: NonNullable<PlanMaking['phase']>): string => (phase === 'trying' || phase === 'repairing' ? `cowork_wiring.make.${phase}` : `cowork_plan.make.${phase}`);

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const PILL = 'inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] border-[var(--border-default)] text-[var(--text-secondary)]';
const PRIMARY = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)]';
const SECONDARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg border text-[12px] font-medium border-[var(--border-default)] text-[var(--text-secondary)]';

/** The draft so far: each step as it was added. */
function Drafting({ making, t, onCancel }: Pick<CoworkPlanMakeProps, 'making' | 't' | 'onCancel'>) {
    const phase = making.phase ?? 'thinking';
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-plan-making">
            <div className="flex items-center gap-2">
                <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin text-[var(--type-ai)]" />
                <span role="status" className="flex-1 text-[12.5px] text-[var(--text-secondary)]">{t(phaseKey(phase), PHASE_FALLBACK[phase])}</span>
                <button type="button" data-testid="cowork-plan-make-cancel" className={SECONDARY} onClick={onCancel}>{t('cowork_plan.make.cancel', 'Stop')}</button>
            </div>
            {making.steps.length > 0 && (
                <ol className="flex flex-col">
                    {making.steps.map((step) => (
                        <li key={step.id} className="flex items-center gap-2.5 py-1" data-testid={`cowork-plan-making-step-${step.id}`}>
                            <CoworkPlanKindTile kind={step.kind} />
                            <span className="text-[13px] font-medium break-words text-[var(--text-primary)]">{step.title}</span>
                            <span className={PILL}>{t(`cowork_plan.kind.${step.kind}`, KIND_FALLBACK[step.kind])}</span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

export default function CoworkPlanMake({ t, making, onMake, onCancel }: CoworkPlanMakeProps) {
    const failure = making.error === null ? null : making.error || t('cowork_plan.make.failed', 'The plan could not be made. Try again.');
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-plan-make">
            <div className="flex items-center gap-1.5">
                <Sparkles aria-hidden="true" className="w-3.5 h-3.5 text-[var(--type-ai)]" />
                <h3 className={LABEL}>{t('cowork_plan.make.heading', 'Let Cowork make the plan')}</h3>
            </div>
            <p className="text-[12px] text-[var(--text-secondary)]">
                {t('cowork_plan.make.hint', 'Cowork drafts the steps from what you wrote: the fixed parts without AI, AI only where it is needed. Nothing runs until you have looked at the plan and approved it.')}
            </p>
            {making.running
                ? <Drafting making={making} t={t} onCancel={onCancel} />
                : (
                    <div>
                        <button type="button" data-testid="cowork-plan-make-start" className={PRIMARY} onClick={onMake}>
                            <Sparkles aria-hidden="true" className="w-3.5 h-3.5" />
                            {t('cowork_plan.make.start', 'Make a plan')}
                        </button>
                    </div>
                )}
            {failure && <p role="alert" className="text-[12.5px] text-[var(--error-ink)]">{failure}</p>}
        </div>
    );
}

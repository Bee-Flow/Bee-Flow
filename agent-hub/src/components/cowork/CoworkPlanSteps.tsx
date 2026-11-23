/**
 * The steps of a plan as one run went through them: a try-out (./CoworkPlanTry.tsx) or a real run in the item's
 * history (./CoworkRunTrace.tsx). Each step says how it went, how long it took, and (folded away) what it got or
 * what it changed or sent. In a try-out a step that would change or send is marked as held back, and its preview
 * says "would have".
 *
 * Presentation only.
 */
import { Check, CircleDashed, Loader2, Minus, ShieldCheck, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { shortDuration, tryToneOf } from './coworkPlanTryModel';
import type { TryTone } from './coworkPlanTryModel';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { PlanEffect, PlanTryStep } from '../../api/coworkPlan.types';

const TONE_ICON: Record<TryTone, LucideIcon> = { pending: CircleDashed, running: Loader2, ok: Check, held: ShieldCheck, failed: X, skipped: Minus };

const TONE_INK: Record<TryTone, string> = {
    pending: 'text-[var(--text-tertiary)]',
    running: 'text-[var(--type-ai)]',
    ok: 'text-[var(--success-ink)]',
    held: 'text-[var(--warning-ink)]',
    failed: 'text-[var(--error-ink)]',
    skipped: 'text-[var(--text-tertiary)]',
};

const TONE_FALLBACK: Record<TryTone, string> = { pending: 'Waiting', running: 'Running', ok: 'Done', held: 'Held back', failed: 'Failed', skipped: 'Not reached' };
const HELD_PREVIEW: Record<PlanEffect, string> = { reads: 'What it got', writes: 'What it would have changed', sends: 'What it would have sent' };
const DONE_PREVIEW: Record<PlanEffect, string> = { reads: 'What it got', writes: 'What it changed', sends: 'What it sent' };

const PILL = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px]';
const QUIET_PILL = `${PILL} border-[var(--border-default)] text-[var(--text-tertiary)]`;

/** The heading of a step's preview: what it got, what it did, or (held back in a try-out) what it would have done. */
function previewLabel(step: PlanTryStep, t: TranslateFn): string {
    if (step.held || step.effect === 'reads') return t(`cowork_plan.try.preview.${step.effect}`, HELD_PREVIEW[step.effect]);
    return t(`cowork_plan.trace.preview.${step.effect}`, DONE_PREVIEW[step.effect]);
}

/** What a step got, or what it changed or sent: folded away until asked for. */
function Preview({ step, t }: { step: PlanTryStep; t: TranslateFn }) {
    if (!step.preview) return null;
    return (
        <details className="group">
            <summary className="cursor-pointer text-[11.5px] text-[var(--text-secondary)] marker:text-[var(--text-tertiary)]">{previewLabel(step, t)}</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md px-2.5 py-2 text-[11.5px] leading-[1.45] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                {step.preview}
            </pre>
        </details>
    );
}

function StepMarks({ step, tone, t }: { step: PlanTryStep; tone: TryTone; t: TranslateFn }) {
    return (
        <>
            {tone === 'held' && (
                <span className={`${PILL} border-[color-mix(in_srgb,var(--warning)_40%,transparent)] text-[var(--warning-ink)]`}>{t('cowork_plan.try.tone.held', TONE_FALLBACK.held)}</span>
            )}
            {tone === 'skipped' && <span className={QUIET_PILL}>{t('cowork_plan.try.tone.skipped', TONE_FALLBACK.skipped)}</span>}
            {step.depth > 0 && <span className={QUIET_PILL}>{t('cowork_plan.try.per_item', 'Once per item')}</span>}
        </>
    );
}

function StepRow({ step, t }: { step: PlanTryStep; t: TranslateFn }) {
    const tone = tryToneOf(step);
    const Icon = TONE_ICON[tone];
    const duration = shortDuration(step.durationMs);
    const quiet = tone === 'pending' || tone === 'skipped';
    return (
        <li className={`flex items-start gap-2.5 py-1.5 ${step.depth > 0 ? 'pl-6' : ''}`} data-testid={`cowork-plan-try-step-${step.id}`} data-tone={tone}>
            <span className={`flex-shrink-0 w-5 h-5 inline-flex items-center justify-center ${TONE_INK[tone]}`}>
                <Icon aria-hidden="true" className={`w-3.5 h-3.5 ${tone === 'running' ? 'animate-spin' : ''}`} />
                <span className="sr-only">{t(`cowork_plan.try.tone.${tone}`, TONE_FALLBACK[tone])}</span>
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-[13px] break-words ${quiet ? 'text-[var(--text-tertiary)]' : 'font-medium text-[var(--text-primary)]'}`}>{step.title}</span>
                    <StepMarks step={step} tone={tone} t={t} />
                    {duration && <span className="ml-auto text-[11.5px] tabular-nums text-[var(--text-tertiary)]">{duration}</span>}
                </div>
                {step.error && <p className="text-[12px] text-[var(--error-ink)]">{step.error}</p>}
                <Preview step={step} t={t} />
            </div>
        </li>
    );
}

export default function CoworkPlanSteps({ steps, t }: { steps: PlanTryStep[]; t: TranslateFn }) {
    return (
        <ol className="flex flex-col">
            {steps.map((step) => <StepRow key={step.id} step={step} t={t} />)}
        </ol>
    );
}

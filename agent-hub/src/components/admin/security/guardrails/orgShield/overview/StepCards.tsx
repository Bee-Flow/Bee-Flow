import { ListChecks } from 'lucide-react';

import { STEPS, factsForStep, stepLink, type CopyContext, type Fact, type StepDef } from './overviewCopy';
import type { GoTo, Posture } from './types';

/**
 * "How things stand": every posture row, grouped into the four steps a
 * message passes through. Read-only on purpose — a summary that also edits is
 * a second home for every setting, and the two drift. Each card's link opens
 * the tab that owns its settings.
 */

function FactLine({ fact }: { fact: Fact }) {
    let valueClass = 'font-normal text-[var(--text-primary)]';
    if (fact.warn) valueClass = 'font-semibold text-[var(--warning-ink)]';
    else if (fact.strong) valueClass = 'font-semibold text-[var(--text-primary)]';
    return (
        <>
            <dt className="text-[var(--text-tertiary)] min-w-0">{fact.label}</dt>
            <dd className="m-0 min-w-0 break-words">
                <span className={valueClass}>{fact.value}</span>
                {fact.note && <span className="text-[var(--text-tertiary)]"> {fact.note}</span>}
            </dd>
        </>
    );
}

interface CardProps {
    step: StepDef;
    posture: Posture;
    ctx: CopyContext;
    onGoTo: GoTo;
}

function StepCard({ step, posture, ctx, onGoTo }: CardProps) {
    const { t } = ctx;
    const facts = factsForStep(posture, step.n, ctx);
    const link = stepLink(step, posture, ctx);
    const titleId = `org-shield-step-${step.n}`;
    return (
        <section
            aria-labelledby={titleId}
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-[var(--shadow-sm)] overflow-hidden min-w-0"
        >
            <div className="flex items-center gap-2 px-4 py-[11px] border-b border-[var(--border-subtle)]">
                <span
                    aria-hidden="true"
                    className="w-[18px] h-[18px] rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] grid place-items-center text-[10px] font-bold shrink-0"
                >
                    {step.n}
                </span>
                <h4 id={titleId} className="m-0 text-[13px] font-semibold text-[var(--text-primary)] min-w-0 truncate">
                    {t(step.titleKey, step.fallback)}
                </h4>
                <button
                    type="button"
                    onClick={() => onGoTo(step.tab)}
                    aria-label={link.ariaLabel}
                    className="ml-auto text-xs font-semibold text-[var(--info-ink)] hover:underline shrink-0"
                >
                    {link.text}
                </button>
            </div>
            <dl className="m-0 grid grid-cols-[minmax(0,150px)_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 text-xs leading-4">
                {facts.map(fact => <FactLine key={fact.id} fact={fact} />)}
            </dl>
        </section>
    );
}

interface Props {
    posture: Posture;
    ctx: CopyContext;
    onGoTo: GoTo;
}

export default function StepCards({ posture, ctx, onGoTo }: Props) {
    const { t } = ctx;
    return (
        <>
            <div className="flex items-center gap-2 flex-wrap pt-1 px-0.5">
                <ListChecks className="w-[15px] h-[15px] text-[var(--text-secondary)]" aria-hidden="true" />
                <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('admin.shield_posture_title', 'How things stand')}
                </h3>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('shield_overview.stand_subtitle', 'in the order a message passes through')}
                </span>
            </div>
            <div className="grid grid-cols-1 @min-[1280px]/pane:grid-cols-2 gap-3">
                {STEPS.map(step => (
                    <StepCard key={step.n} step={step} posture={posture} ctx={ctx} onGoTo={onGoTo} />
                ))}
            </div>
        </>
    );
}

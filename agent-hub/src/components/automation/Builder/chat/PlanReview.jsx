import { CheckCircle2, ChevronDown, CircleHelp, ClipboardList, FlaskConical, Hammer, ListChecks, MessageSquare, Pause, ShieldCheck, X } from 'lucide-react';
import { createElement, useId, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';

export default function PlanReview({ plan, running, onApprove, onComment, onClose, onReject = null }) {
    const { t } = useTranslation();
    const sectionId = useId();
    const [pauseAfterStep, setPauseAfterStep] = useState(!!plan?.pauseAfterStep);
    if (!plan) return null;
    const canBuild = plan.status === 'review' || plan.status === 'paused';
    const sections = [
        ['steps', t('routines.assistant.steps', 'The steps'), ListChecks],
        ['assumptions', t('routines.assistant.assumptions', 'What I assume'), CircleHelp],
        ['prerequisites', t('routines.assistant.prerequisites', 'What is needed'), ShieldCheck],
        ['tests', t('routines.assistant.tests', 'How I will test it'), FlaskConical],
    ].filter(([key]) => Array.isArray(plan[key]) && plan[key].length > 0);
    const waiting = plan.status === 'paused' ? t('routines.assistant.plan_paused', 'Building is paused. Continue to allow the next step.') : t('routines.assistant.plan_waiting', 'The flow stays unchanged until you approve this plan.');
    return <div className="absolute inset-0 z-30 flex flex-col bg-[var(--bg-secondary)]" data-testid="plan-review">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3 sm:px-6">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--type-ai)_10%,transparent)] text-[var(--type-ai)]"><ClipboardList size={16} /></span>
            <span className="text-sm font-semibold text-[var(--text-primary)]">{t('routines.assistant.plan', 'Plan')}</span><span className="rounded-md border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">v{plan.version}</span>
            <span className="flex-1" />
            {canBuild && <span className="hidden items-center gap-1.5 text-[11px] text-[var(--text-tertiary)] sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[var(--type-ai)]" />{plan.status === 'paused' ? t('routines.assistant.paused', 'Paused') : t('routines.assistant.ready_review', 'Ready for review')}</span>}
            <button type="button" onClick={onClose} aria-label={t('routines.assistant.show_canvas', 'Show canvas')} className="rounded-lg p-2 text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-smooth px-4 py-6 text-[var(--text-primary)] sm:px-8 sm:py-8">
            <div className="mx-auto max-w-[820px] space-y-5">
                <div className="pb-2">
                    <h2 className="text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{plan.title}</h2>
                    {plan.goal && <p className="mt-3 max-w-[72ch] text-sm leading-6 text-[var(--text-secondary)]">{plan.goal}</p>}
                    <nav aria-label={t('routines.assistant.plan_sections', 'Plan sections')} className="mt-5 flex flex-wrap gap-2">{sections.map(([key, title, Icon]) => <a key={key} href={`#${sectionId}-${key}`} onClick={() => { const section = document.getElementById(`${sectionId}-${key}`); section?.querySelector('details')?.setAttribute('open', ''); }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--type-ai)] hover:text-[var(--type-ai)]">{createElement(Icon, { size: 12 })}{title}<span className="ml-1 text-[var(--text-tertiary)]">{plan[key].length}</span></a>)}</nav>
                </div>
                {sections.map(([key, title, Icon]) => <section key={key} id={`${sectionId}-${key}`} className="scroll-mt-5 overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)]">
                    <details open={key === 'steps'} className="group/section">
                    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3.5 hover:bg-[var(--bg-secondary)]/40 group-open/section:border-b group-open/section:border-[var(--border-default)] sm:px-5 [&::-webkit-details-marker]:hidden">{createElement(Icon, { size: 16, className: key === 'steps' ? 'text-[var(--type-ai)]' : 'text-[var(--text-tertiary)]' })}<h3 className="flex-1 text-sm font-semibold">{title}</h3><span className="rounded-md bg-[var(--bg-secondary)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-tertiary)]">{plan[key].length}</span><ChevronDown size={14} className="text-[var(--text-tertiary)] transition-transform group-open/section:rotate-180" /></summary>
                    <div className="divide-y divide-[var(--border-default)]">{plan[key].map((line, i) => <div key={i} className="group flex items-start gap-3 px-4 py-4 transition-colors hover:bg-[var(--bg-secondary)]/40 sm:gap-4 sm:px-5">
                        {key === 'steps' ? <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--type-ai)_9%,transparent)] text-xs font-semibold tabular-nums text-[var(--type-ai)]">{String(i + 1).padStart(2, '0')}</span> : <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-tertiary)]/40" />}
                        <p className="min-w-0 flex-1 break-words text-sm leading-6">{line}</p>
                        {onComment && <button type="button" disabled={running} onClick={() => onComment(key, i, line)} title={t('routines.assistant.comment', 'Comment on this line')} aria-label={`${t('routines.assistant.comment', 'Comment on this line')}: ${line}`} className="shrink-0 rounded-lg p-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--type-ai)] focus-visible:opacity-100 disabled:opacity-40 sm:opacity-40 sm:group-hover:opacity-100"><MessageSquare size={14} /></button>}
                    </div>)}</div>
                    </details>
                </section>)}
                {!canBuild && plan.status === 'built' && <p className="flex items-center gap-2 px-1 text-xs text-[var(--text-secondary)]"><CheckCircle2 size={14} className="text-[var(--type-ai)]" />{t('routines.assistant.plan_built', 'This plan has been built.')}</p>}
            </div>
        </div>
        {canBuild && <div className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3 sm:px-6 sm:py-4">
            <div className="mx-auto flex max-w-[820px] flex-wrap items-center gap-x-5 gap-y-3">
                <div className="min-w-0 flex-1 basis-60"><p className="text-xs leading-5 text-[var(--text-secondary)]">{waiting}</p><label className="mt-1.5 inline-flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-tertiary)]"><input type="checkbox" disabled={running} checked={pauseAfterStep} onChange={e => setPauseAfterStep(e.target.checked)} className="h-3.5 w-3.5 rounded accent-[var(--type-ai)]" /><Pause size={11} />{t('routines.assistant.pause_each', 'Pause after each step')}</label></div>
                <div className="flex items-center gap-2">{onReject && <button type="button" disabled={running} onClick={onReject} className="rounded-xl px-3 py-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50">{t('routines.assistant.discard', 'Discard')}</button>}
                    <button type="button" disabled={running} onClick={() => onApprove(pauseAfterStep)} className="flex items-center gap-2 rounded-xl bg-[var(--text-primary)] px-4 py-2.5 text-xs font-semibold text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"><Hammer size={14} />{plan.status === 'paused' ? t('routines.assistant.continue_plan', 'Continue plan') : t('routines.assistant.build_plan', 'Build this plan')}</button>
                </div>
            </div>
        </div>}
    </div>;
}

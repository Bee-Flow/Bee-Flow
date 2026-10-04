import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReasonCode, RepeatingSuggestion } from '../../../../../api/queries/automation/repeating';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { CANVAS_BUTTON_PRIMARY, EYEBROW, familyClasses } from '../../../../automation/Builder/flow/canvasClasses';
import CadenceStrip from './CadenceStrip';
import EvidencePills from './EvidencePills';
import PatternStepPreview from './PatternStepPreview';
import { NOT_REPETITIVE, legacyEvidence, patternEyebrow, reasonTexts, templateParts } from './patternView';

export type PatternCardVariant = 'pattern' | 'idea';

export interface PatternCardProps {
    suggestion: RepeatingSuggestion;
    labelFor: (id: string) => string;
    /** `idea`: from the ideas fallback, not seen in the viewer's activity; no evidence. */
    variant?: PatternCardVariant;
    /** A re-scan is running: the card dims and its actions wait. */
    busy?: boolean;
    onBuild: (s: RepeatingSuggestion, opts: { autoSend: boolean }) => void;
    onSnooze?: (s: RepeatingSuggestion) => void;
    onNotRepetitive?: (s: RepeatingSuggestion, reason: ReasonCode) => void;
    onDismiss?: (s: RepeatingSuggestion) => void;
}

const SECONDARY = 'px-3 py-[7px] rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition disabled:opacity-50 disabled:cursor-not-allowed';
const GHOST = 'inline-flex items-center gap-1 px-2 py-[7px] rounded-lg text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50 disabled:cursor-not-allowed';

/** The kicker: "Pattern · Weekly · Mon 09–10", or what an older scan / an idea calls itself. */
function eyebrowOf(s: RepeatingSuggestion, variant: PatternCardVariant, t: TranslateFn): { head: string; rest: string; tone: string } {
    if (s.pattern && variant === 'pattern') {
        const [head, ...rest] = patternEyebrow(s.pattern, t).split(' · ');
        return { head, rest: rest.join(' · '), tone: familyClasses('trigger').text };
    }
    if (variant === 'pattern' && s.groundedIn === 'activity') {
        return { head: t('automations.repeating.observed', 'Observed'), rest: '', tone: 'text-[var(--success)]' };
    }
    return { head: t('automations.repeating.idea', 'Idea'), rest: '', tone: familyClasses('ai').text };
}

/** The masked template in monospace, its placeholders as soft chips. */
function TemplateLine({ template }: { template: string }) {
    const { t } = useTranslation();
    const parts = templateParts(template, t);
    return (
        <p className="m-0 flex items-baseline gap-2 min-w-0 text-[11px]" data-testid="pattern-template">
            <span className="shrink-0 text-[var(--text-tertiary)]">{t('automations.repeating.templateLabel', 'Looks like')}</span>
            <code className="min-w-0 truncate font-mono text-[var(--text-secondary)]">
                {parts.map((p, i) => (p.placeholder
                    ? <span key={i} className="px-1 mx-px rounded bg-[var(--bg-tertiary)] text-[var(--type-trigger)]">{p.text}</span>
                    : <span key={i}>{p.text}</span>))}
            </code>
        </p>
    );
}

/** "Why this ranks here": the server's reason codes, in words. */
function WhyRanks({ reasons }: { reasons: string[] }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const listId = useId();
    const texts = reasonTexts(reasons, t);
    if (!texts.length) return null;
    return (
        <div className="text-[11px]">
            <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(o => !o)}
                className="inline-flex items-center gap-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition">
                {open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
                {t('automations.repeating.whyToggle', 'Why this ranks here')}
            </button>
            {open && (
                <ul id={listId} className="m-0 mt-1 pl-4 list-disc text-[var(--text-secondary)] flex flex-col gap-0.5">
                    {texts.map(r => <li key={r}>{r}</li>)}
                </ul>
            )}
        </div>
    );
}

/** "Not repetitive ▾" and its four reasons. */
function NotRepetitiveMenu({ disabled, onPick }: { disabled: boolean; onPick: (code: ReasonCode) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const menuId = useId();
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [open]);
    return (
        <div ref={rootRef} className="relative">
            <button type="button" className={GHOST} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(o => !o)}>
                {t('automations.repeating.notRepetitive', 'Not repetitive')}
                <ChevronDown size={12} aria-hidden="true" />
            </button>
            {open && (
                <div id={menuId} role="menu" className="absolute right-0 bottom-full mb-1 z-20 min-w-[15rem] py-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg">
                    {NOT_REPETITIVE.map(r => (
                        <button key={r.code} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(r.code); }}
                            className="block w-full text-left px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]">
                            {t(r.key, r.en)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function CardActions({ suggestion, variant, busy, onBuild, onSnooze, onNotRepetitive, onDismiss }: Omit<PatternCardProps, 'labelFor'> & { busy: boolean; variant: PatternCardVariant }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <button type="button" className={CANVAS_BUTTON_PRIMARY} disabled={busy} onClick={() => onBuild(suggestion, { autoSend: true })}>
                {t('automations.repeating.buildThis', 'Build this')}
            </button>
            <button type="button" className={SECONDARY} disabled={busy} onClick={() => onBuild(suggestion, { autoSend: false })}>
                {t('automations.repeating.adjust', 'Adjust first')}
            </button>
            <span className="ml-auto flex items-center gap-0.5">
                {variant === 'pattern' && onSnooze && (
                    <button type="button" className={GHOST} disabled={busy} onClick={() => onSnooze(suggestion)}
                        title={t('automations.repeating.notNowHint', 'Hide this pattern for 30 days')}>
                        {t('automations.repeating.notNow', 'Not now')}
                    </button>
                )}
                {variant === 'pattern' && onNotRepetitive && <NotRepetitiveMenu disabled={busy} onPick={code => onNotRepetitive(suggestion, code)} />}
                {variant === 'idea' && onDismiss && (
                    <button type="button" disabled={busy} onClick={() => onDismiss(suggestion)}
                        aria-label={t('automations.repeating.dismiss', 'Dismiss suggestion')} title={t('automations.repeating.dismiss', 'Dismiss suggestion')}
                        className="p-1.5 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50">
                        <X size={13} aria-hidden="true" />
                    </button>
                )}
            </span>
        </div>
    );
}

/** What the miner measured: pills, the automation it would become, the template and the ranking reasons. */
function PatternEvidence({ suggestion, labelFor }: { suggestion: RepeatingSuggestion; labelFor: (id: string) => string }) {
    const p = suggestion.pattern ?? null;
    const legacy = p ? '' : legacyEvidence(suggestion.evidence);
    return (
        <>
            <EvidencePills suggestion={suggestion} labelFor={labelFor} />
            {legacy && <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{legacy}</p>}
            {p && <PatternStepPreview pattern={p} labelFor={labelFor} />}
            {p?.template && <TemplateLine template={p.template} />}
            {p && <WhyRanks reasons={p.reasons} />}
        </>
    );
}

/**
 * One repeating pattern as a canvas card: the trigger family's bar, the
 * kicker ("Pattern · Weekly · Mon 09–10") with the weekday strip beside it,
 * the title and one line of why, the evidence pills, the automation it would
 * become as mini nodes, the masked template, and why it ranks where it does.
 *
 * Build this sends the pattern to the builder straight away; Adjust first
 * opens the builder with it filled in. Not now hides it for 30 days; Not
 * repetitive says why it is wrong. An idea (the fallback, not seen in the
 * viewer's activity) has no evidence and is simply dismissed.
 */
export default function PatternCard({ suggestion, labelFor, variant = 'pattern', busy = false, ...actions }: PatternCardProps) {
    const { t } = useTranslation();
    const pattern = variant === 'pattern' ? suggestion.pattern ?? null : null;
    const eyebrow = eyebrowOf(suggestion, variant, t);
    const bar = familyClasses(variant === 'idea' ? 'ai' : 'trigger').bar;
    return (
        <article
            className={`relative flex flex-col gap-2.5 min-w-0 pl-[18px] pr-4 py-3.5 bg-[var(--bg-card)] border border-solid border-[var(--border-default)] rounded-[var(--radius-md)] transition-opacity ${bar} ${busy ? 'opacity-60' : ''}`}
            data-testid="pattern-card" data-variant={variant} aria-busy={busy || undefined}
        >
            <header className="flex items-start gap-3">
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <div className={EYEBROW} data-testid="pattern-eyebrow">
                        <span className={`truncate ${eyebrow.tone}`}>{eyebrow.head}</span>
                        {eyebrow.rest && <span className="shrink-0 text-[var(--text-tertiary)]">· {eyebrow.rest}</span>}
                    </div>
                    <h3 className="m-0 text-[14px] font-semibold leading-snug text-[var(--text-primary)]">{suggestion.title}</h3>
                    {suggestion.description && <p className="m-0 text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-2">{suggestion.description}</p>}
                </div>
                {pattern && <CadenceStrip histogram={pattern.weekdayHistogram} />}
            </header>
            {variant === 'pattern' && <PatternEvidence suggestion={suggestion} labelFor={labelFor} />}
            <CardActions suggestion={suggestion} variant={variant} busy={busy} {...actions} />
        </article>
    );
}

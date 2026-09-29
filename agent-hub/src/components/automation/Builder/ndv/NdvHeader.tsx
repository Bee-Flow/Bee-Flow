import { ChevronLeft, ChevronRight, CircleCheck, CircleX, Loader2, Maximize2, Minimize2, Play, RotateCcw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import SaveStatus from '../../../shared/SaveStatus';
import type { FlowStep } from '../flow/types';
import { familyVarClass } from './familyVar';
import { PILL_CLASS, type StatusPill } from './ndvModel';
import NdvStepMenu, { type NdvStepMenuProps } from './NdvStepMenu';
import StepGlyph from './StepGlyph';

/**
 * The step drawer's 56px header (round 4, artboard 4a): a 6px family bar, a
 * 32px tinted tile with the step's glyph, the kicker ("Action · step 2 of 8")
 * in the family colour over the title, the ‹ › pager, the last run's status
 * pill, the autosave chip, Retry when the step failed, the primary Test step,
 * the ⋯ menu and close. The column toggles and the size control stay here
 * too, compact: one click from the quick drawer to Incoming or Continues on
 * was an owner request and outranks a tidier row.
 *
 * Fit stages on the header's own width (@container/ndvhead):
 *   <1500px  the quick drawer's Simple / All options goes: its footer has
 *            the same switch as a link, and two segmented controls side by
 *            side crowded a laptop's header
 *   <1180px  Retry keeps only its icon (the autosave chip always shows: its
 *            error state carries the retry for a failed save)
 *   <960px   Test step too, and the toggles drop the Settings segment (it
 *            is always on); Incoming / Continues on stay, because in a narrow
 *            drawer they are how you switch the one side column
 *   <760px   the status pill
 *   <640px   the column toggles (the size button still reaches the full view)
 */

export interface NdvHeaderProps {
    step: FlowStep;
    family: string | null;
    kicker: string;
    title: string;
    position: { index: number; total: number; prevId?: string | null; nextId?: string | null };
    canNavigate: boolean;
    goPrev: () => void;
    goNext: () => void;
    pill: StatusPill | null;
    save: { state: unknown; lastSavedAt: Date | null; onRetry: (() => void) | null };
    onRetryStep: (() => void) | null;
    retryDisabled: boolean;
    onTest: (() => void) | null;
    testBusy: boolean;
    testDisabled: boolean;
    menu: NdvStepMenuProps | null;
    columns: { quick: boolean; inputOpen: boolean; outputOpen: boolean; onInput: () => void; onOutput: () => void };
    modeToggle: ReactNode;
    onExpand: (() => void) | null;
    onShrink: (() => void) | null;
    onClose: () => void;
}

const outline = 'inline-flex items-center gap-1.5 h-[30px] px-3 rounded-lg border border-[var(--border-default)] text-[12px] font-medium transition';
const iconBtn = 'w-[30px] h-[30px] shrink-0 grid place-items-center rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition';
const pagerBtn = 'w-7 h-7 grid place-items-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:hover:bg-transparent transition';
const seg = (on: boolean) => `px-2.5 py-1 rounded-md transition ${on ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;

export default function NdvHeader(p: NdvHeaderProps) {
    const { t } = useTranslation();
    const famVar = familyVarClass(p.family);
    const { quick, inputOpen, outputOpen } = p.columns;
    const inputOn = !quick && inputOpen;
    const outputOn = !quick && outputOpen;
    return (
        <div className={`@container/ndvhead ${famVar} flex items-center gap-3 px-4 h-14 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] flex-shrink-0 text-[12px]`}>
            <span aria-hidden="true" className="shrink-0 w-1.5 h-[30px] rounded-[3px] bg-[var(--fam)]" data-testid="ndv-type-bar" />
            <span aria-hidden="true" className="shrink-0 w-8 h-8 rounded-[9px] grid place-items-center bg-[color-mix(in_srgb,var(--fam)_16%,transparent)] text-[var(--fam)]" data-testid="ndv-type-tile">
                <StepGlyph step={p.step} size={16} />
            </span>
            {/* Identity: the name is the focal point (it is how you check you
                opened the node you meant to, BFSF-333); the family and the
                position sit above it as the kicker. */}
            <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[.06em] font-semibold truncate text-[var(--fam)]" data-testid="ndv-kicker">
                    {p.kicker}
                    {p.position.total > 1 && (
                        // No leading dot when there is no family word (a start step has none).
                        <span>{p.kicker ? ' · ' : ''}<span>{t('routines.ndv.step_of', 'Step {n} of {total}', { n: p.position.index, total: p.position.total })}</span></span>
                    )}
                </div>
                <div data-testid="ndv-title" className="text-[15px] font-semibold text-[var(--text-primary)] truncate leading-tight" title={typeof p.step.tool === 'string' ? p.step.tool : undefined}>
                    {p.title}
                </div>
            </div>
            {/* Where am I in the flow, and the way to the next one (BFSF-332):
                beside the name at both densities, in execution order. */}
            {p.canNavigate && (
                <div className="flex items-center gap-0.5 shrink-0 ml-1">
                    <button type="button" onClick={p.goPrev} disabled={!p.position.prevId} title={t('routines.ndv.prev_step_title', 'Previous step in the flow (Alt+←)')} aria-label={t('routines.ndv.prev_step', 'Previous step')} className={pagerBtn}>
                        <ChevronLeft size={14} />
                    </button>
                    <button type="button" onClick={p.goNext} disabled={!p.position.nextId} title={t('routines.ndv.next_step_title', 'Next step in the flow (Alt+→)')} aria-label={t('routines.ndv.next_step', 'Next step')} className={pagerBtn}>
                        <ChevronRight size={14} />
                    </button>
                </div>
            )}
            {p.pill && (
                <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full font-semibold whitespace-nowrap ${PILL_CLASS[p.pill.tone]} @max-[760px]/ndvhead:hidden`} data-testid="ndv-status-pill" data-tone={p.pill.tone}>
                    {p.pill.tone === 'error' ? <CircleX size={12} /> : p.pill.tone === 'running' ? <Loader2 size={12} className="animate-spin" /> : <CircleCheck size={12} />}
                    {p.pill.label}
                </span>
            )}
            <div className="flex-1" />
            {p.modeToggle && <span className="@max-[1500px]/ndvhead:hidden">{p.modeToggle}</span>}
            {/* Which columns are open (design 1h): two independent booleans.
                At quick density asking for a side column grows the drawer to
                the full view with that column open. */}
            <div className="shrink-0 inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg-tertiary)] font-medium whitespace-nowrap @max-[640px]/ndvhead:hidden" role="group" aria-label={t('routines.ndv.drawer_columns', 'Drawer columns')}>
                <button type="button" onClick={p.columns.onInput} aria-pressed={inputOn} title={inputOn ? t('routines.ndv.hide_input', 'Hide input') : t('routines.ndv.show_input', 'Show input')} aria-label={inputOn ? t('routines.ndv.hide_input', 'Hide input') : t('routines.ndv.show_input', 'Show input')} className={seg(inputOn)}>
                    {t('routines.ndv.incoming', 'Incoming')}
                </button>
                <span aria-hidden="true" className={`${seg(true)} @max-[960px]/ndvhead:hidden`}>{t('routines.ndv.settings', 'Settings')}</span>
                <button type="button" onClick={p.columns.onOutput} aria-pressed={outputOn} title={outputOn ? t('routines.ndv.hide_output', 'Hide output') : t('routines.ndv.show_output', 'Show output')} aria-label={outputOn ? t('routines.ndv.hide_output', 'Hide output') : t('routines.ndv.show_output', 'Show output')} className={seg(outputOn)}>
                    {t('routines.ndv.continues', 'Continues on')}
                </button>
            </div>
            <SaveStatus saveState={p.save.state} lastSavedAt={p.save.lastSavedAt} onRetry={p.save.onRetry} showWhenIdle size={11} className="shrink-0" />
            {p.onRetryStep && (
                <button type="button" onClick={p.onRetryStep} disabled={p.retryDisabled} title={t('routines.ndv.retry_title', 'Retry this step and continue downstream from here')} aria-label={t('routines.ndv.retry', 'Retry')} className={`${outline} shrink-0 whitespace-nowrap text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40`}>
                    <RotateCcw size={13} /> <span className="@max-[1180px]/ndvhead:hidden">{t('routines.ndv.retry', 'Retry')}</span>
                </button>
            )}
            {p.onTest && (
                <button
                    type="button"
                    onClick={p.onTest}
                    disabled={p.testDisabled}
                    title={t('routines.ndv.test_step_title', 'Test this step only (uses upstream replay or pinned data)')}
                    aria-label={t('routines.ndv.test_step', 'Test step')}
                    className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-[30px] px-3.5 rounded-lg text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-85 disabled:opacity-40 transition"
                >
                    {p.testBusy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} fill="currentColor" />}
                    <span className="@max-[960px]/ndvhead:hidden">{t('routines.ndv.test_step', 'Test step')}</span>
                </button>
            )}
            {p.menu && <NdvStepMenu {...p.menu} />}
            {p.onExpand && (
                <button type="button" onClick={p.onExpand} title={t('routines.ndv.expand_full_title', 'Open the full view — input data and output side by side')} aria-label={t('routines.ndv.expand_full', 'Expand to the full view')} className={iconBtn}>
                    <Maximize2 size={15} />
                </button>
            )}
            {p.onShrink && (
                <button type="button" onClick={p.onShrink} title={t('routines.ndv.shrink_quick', 'Shrink to the small dialog')} aria-label={t('routines.ndv.shrink_quick', 'Shrink to the small dialog')} className={iconBtn}>
                    <Minimize2 size={15} />
                </button>
            )}
            <button type="button" onClick={p.onClose} aria-label={t('common.close', 'Close')} className={iconBtn}><X size={15} /></button>
        </div>
    );
}

import { Check, ChevronDown, Eye, Play } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import useDismiss from './useDismiss';
import { viewOnlyRunHint } from '@/api/queries/automation/runAccess';

export interface RunTriggerOption { id: string; label: string; kind?: string }

interface TestRunMenuProps {
    busy?: boolean;
    /** A run is starting or going, or the form overlay is open: nothing new starts until it is over (RUN-12). */
    runBlocked?: boolean;
    onDryRun?: ((from: string | null) => void) | null;
    onRunLive?: ((from: string | null) => void) | null;
    /** false when the server says this caller may not start a run: "Run live" stays, disabled, with the reason. */
    canRunLive?: boolean;
    /** The ADDITIONAL entry points of a multi-trigger automation; empty otherwise. */
    triggers?: RunTriggerOption[];
    primaryLabel?: string;
}

const ITEM = 'w-full text-left px-3 py-2 text-[13px] hover:bg-[var(--bg-secondary)] transition flex items-start gap-2';

/**
 * "Test" (artboard 5a): an outline split button. The button itself is a dry
 * run of the working copy (nothing is sent), the safe default; Run live (a
 * test run with real actions) and the "Start from" choice of a multi-trigger
 * automation sit behind the chevron, one deliberate step further away. Both
 * handlers get the chosen trigger id (null = the primary), so the shell sends
 * that trigger's own sample. While a run is going both wait (`runBlocked`).
 */
export default function TestRunMenu({ busy = false, runBlocked = false, onDryRun, onRunLive, canRunLive = true, triggers = [], primaryLabel = 'Primary trigger' }: TestRunMenuProps) {
    const { t } = useTranslation();
    const { open, setOpen, ref } = useDismiss();
    const [fromId, setFromId] = useState<string | null>(null);
    // A removed trigger must not linger as the selection.
    const from = fromId && triggers.some(tr => tr.id === fromId) ? fromId : null;
    const fromLabel = from ? triggers.find(tr => tr.id === from)?.label ?? null : null;
    const hasMenu = typeof onRunLive === 'function' || triggers.length > 0;

    const disabled = busy || runBlocked;
    const testTitle = runBlocked
        ? t('automation_testing.header.run_blocked', 'A run is going. Wait for it, or stop it first.')
        : fromLabel
            ? t('automation_testing.header.dry_run_from_title', 'Dry run from "{label}": nothing is sent', { label: fromLabel })
            : t('automation_testing.header.dry_run_title', 'Dry run of the working copy: nothing is sent');
    const pick = (fn?: ((f: string | null) => void) | null) => { setOpen(false); fn?.(from); };

    return (
        <div ref={ref} className="relative flex-shrink-0">
            <div className="flex items-stretch h-8 rounded-lg overflow-hidden border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)]">
                <button
                    type="button"
                    onClick={() => onDryRun?.(from)}
                    disabled={disabled}
                    aria-label={t('automations.header.test', 'Test')}
                    title={testTitle}
                    className={`flex items-center gap-1.5 pl-3 ${hasMenu ? 'pr-2.5' : 'pr-3'} hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50`}
                >
                    <Play size={13} />
                    <span className="@max-[1180px]/bar:hidden">{t('automations.header.test', 'Test')}</span>
                    {fromLabel && (
                        <span className="@max-[1320px]/bar:hidden max-w-[140px] truncate text-[11px] font-normal text-[var(--text-tertiary)]">
                            {t('automations.header.test_from', 'from {label}', { label: fromLabel })}
                        </span>
                    )}
                </button>
                {hasMenu && (
                    <>
                        <span aria-hidden="true" className="w-px bg-[var(--border-default)]" />
                        <button
                            type="button"
                            onClick={() => setOpen(o => !o)}
                            disabled={disabled}
                            aria-haspopup="menu"
                            aria-expanded={open}
                            aria-label={t('automations.header.more_ways_to_run', 'More ways to run')}
                            title={t('automations.header.more_ways_to_run', 'More ways to run')}
                            className="flex items-center px-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50"
                        >
                            <ChevronDown size={14} />
                        </button>
                    </>
                )}
            </div>
            {open && (
                <div role="menu" className="absolute right-0 top-full mt-1 z-40 w-60 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg py-1">
                    <button type="button" role="menuitem" onClick={() => pick(onDryRun)} className={ITEM}>
                        <Eye size={14} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
                        <span className="min-w-0">
                            <span className="block text-[var(--text-primary)]">{t('automation_testing.header.dry_run', 'Dry run (nothing sent)')}</span>
                            <span className="block text-[11px] text-[var(--text-tertiary)]">{t('automation_testing.header.dry_run_hint', 'Writes are simulated; forms and approvals wait for you')}</span>
                        </span>
                    </button>
                    {typeof onRunLive === 'function' && (
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => pick(onRunLive)}
                            disabled={!canRunLive}
                            title={canRunLive ? undefined : viewOnlyRunHint(t)}
                            className={`${ITEM} disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            <Play size={14} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
                            <span className="min-w-0">
                                <span className="block text-[var(--text-primary)]">{t('automation_testing.header.run_live', 'Run live (test, real actions)')}</span>
                                <span className="block text-[11px] text-[var(--text-tertiary)]">{canRunLive ? t('automation_testing.header.run_live_hint', 'Every step acts for real; approvals go to you') : viewOnlyRunHint(t)}</span>
                            </span>
                        </button>
                    )}
                    {triggers.length > 0 && (
                        <>
                            <div role="separator" className="my-1 border-t border-[var(--border-default)]" />
                            <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                                {t('automations.header.start_from', 'Start from')}
                            </div>
                            {[{ id: null as string | null, label: primaryLabel, kind: 'primary' }, ...triggers].map(tr => (
                                <button
                                    key={tr.id || '__primary'}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={from === tr.id}
                                    onClick={() => setFromId(tr.id)}
                                    title={tr.id ? tr.kind : t('automations.header.primary_trigger_hint', 'The main trigger of this automation')}
                                    className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--bg-secondary)] transition flex items-center gap-2"
                                >
                                    <span className={`w-3.5 shrink-0 text-[var(--accent-primary)] ${from === tr.id ? '' : 'invisible'}`}><Check size={14} /></span>
                                    <span className="min-w-0 truncate text-[var(--text-primary)]">{tr.label}</span>
                                </button>
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

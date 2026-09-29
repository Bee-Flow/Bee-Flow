import { ChevronDown, Link2, ListFilter, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { triggerLabel } from './runLanguage';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';

// A .jsx module whose `= null` defaults would type its props as null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

/** The run log's filters, as useExecutions holds them. */
export interface RunLogFilters {
    status?: string;
    range?: string;
    trigger?: string | null;
    mode?: string;
    automationId?: string | null;
}

export interface AutomationOption { id: string; title?: string | null }

/** What the secondary filters need: the three selects and their sources. */
export interface SecondaryFilterProps {
    filters: RunLogFilters;
    set: (patch: Partial<RunLogFilters>) => void;
    triggerKinds: string[];
    showModePicker: boolean;
    showAutomationPicker: boolean;
    automationOptions: AutomationOption[];
}

/** The default of each secondary filter: what "Clear" goes back to. */
export const SECONDARY_DEFAULTS: Partial<RunLogFilters> = { trigger: null, mode: 'live', automationId: null };

export function modeOptions(t: TranslateFn) {
    return [
        { key: 'live', label: t('runs.log.mode_live', 'Live runs') },
        { key: 'dry_run', label: t('runs.log.mode_tests', 'Tests only') },
        { key: 'both', label: t('runs.log.mode_both', 'Live runs and tests') },
    ];
}

/** The secondary filters that narrow the list now, as words ("Schedule · Tests only"). */
export function narrowedWords(t: TranslateFn, p: SecondaryFilterProps): string[] {
    const { filters } = p;
    return [
        filters.trigger ? triggerLabel(filters.trigger) : null,
        p.showModePicker && filters.mode && filters.mode !== 'live'
            ? modeOptions(t).find(m => m.key === filters.mode)?.label || filters.mode
            : null,
        p.showAutomationPicker && filters.automationId
            ? p.automationOptions.find(o => o.id === filters.automationId)?.title || t('runs.log.one_automation', 'One automation')
            : null,
    ].filter((w): w is string => !!w);
}

const SELECT = 'appearance-none w-full pl-2.5 pr-7 py-1 rounded-lg text-xs bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition truncate';

function SelectBox({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <div className={`relative ${className}`}>
            {children}
            <ChevronDown size={12} aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        </div>
    );
}

/** Trigger, live/test and automation: the same selects inline and in the Filter panel. */
export function SecondarySelects({ p, stacked = false }: { p: SecondaryFilterProps; stacked?: boolean }) {
    const { t } = useTranslation();
    const { filters, set } = p;
    const width = (inline: string) => (stacked ? 'w-full' : inline);
    const heading = 'text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]';
    const field = (label: string, control: ReactNode) => (stacked
        ? <div className="flex flex-col gap-1.5"><span className={heading}>{label}</span>{control}</div>
        : control);
    return (
        <>
            {field(t('runs.log.filter_trigger', 'Trigger'), (
                <SelectBox className={width('max-w-[12rem]')}>
                    <select value={filters.trigger || ''} onChange={(e) => set({ trigger: e.target.value || null })} aria-label={t('runs.log.filter_trigger_label', 'Filter by trigger')} className={SELECT}>
                        <option value="">{t('runs.log.any_trigger', 'Any trigger')}</option>
                        {p.triggerKinds.map(kind => <option key={kind} value={kind}>{triggerLabel(kind)}</option>)}
                    </select>
                </SelectBox>
            ))}
            {/* Hidden for Steps: their runs are all tests. */}
            {p.showModePicker && field(t('runs.log.filter_mode', 'Live or test'), (
                <SelectBox className={width('')}>
                    <select value={filters.mode || 'live'} onChange={(e) => set({ mode: e.target.value })} aria-label={t('runs.log.filter_mode_label', 'Live or test runs')} className={SELECT}>
                        {modeOptions(t).map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                </SelectBox>
            ))}
            {p.showAutomationPicker && field(t('runs.log.filter_automation', 'Automation'), (
                <SelectBox className={width('max-w-[14rem]')}>
                    <select value={filters.automationId || ''} onChange={(e) => set({ automationId: e.target.value || null })} aria-label={t('runs.log.filter_automation_label', 'Filter by automation')} className={SELECT}>
                        <option value="">{t('runs.log.all_automations', 'All automations')}</option>
                        {p.automationOptions.map(o => <option key={o.id} value={o.id}>{o.title || t('runs.log.untitled', 'Untitled')}</option>)}
                    </select>
                </SelectBox>
            ))}
        </>
    );
}

/** The "Clear" link that puts the secondary filters back. */
export function ClearFilters({ onClear, label, className = '' }: { onClear: () => void; label: string; className?: string }) {
    return (
        <button type="button" onClick={onClear} className={`inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition whitespace-nowrap ${className}`}>
            <X size={11} aria-hidden /> {label}
        </button>
    );
}

/**
 * The folded secondary filters: one "Filter" button that names what it
 * narrows ("Filter: Schedule · Tests only"), opening the same selects.
 */
export function FilterMenu({ p }: { p: SecondaryFilterProps }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const picked = narrowedWords(t, p);
    const filter = t('runs.log.filter', 'Filter');
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
                data-testid="executions-filter-button"
                className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-xs transition ${
                    picked.length
                        ? 'border-[var(--accent-primary)] text-[var(--text-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)]'
                        : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                }`}
            >
                <ListFilter size={13} aria-hidden />
                <span className="truncate max-w-[16rem]">{picked.length ? `${filter}: ${picked.join(' · ')}` : filter}</span>
                <ChevronDown size={12} aria-hidden className="opacity-60" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                width={280}
                role="dialog"
                aria-label={filter}
                className="p-3 flex flex-col gap-3"
                data-testid="executions-filter-panel"
            >
                <SecondarySelects p={p} stacked />
                {picked.length > 0 && (
                    <ClearFilters className="self-start" label={t('runs.log.clear_filters', 'Clear filters')} onClear={() => { p.set(SECONDARY_DEFAULTS); setOpen(false); }} />
                )}
            </AnchoredMenu>
        </>
    );
}

/** The paste-a-run-link box; `onDone` fires after a jump. */
export function JumpBox({ onJump, runIdFromText, autoFocus = false, onDone = null }: {
    onJump: (runId: string) => void;
    runIdFromText: (text: string) => string | null;
    autoFocus?: boolean;
    onDone?: (() => void) | null;
}) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [invalid, setInvalid] = useState(false);
    const label = t('runs.log.jump_placeholder', 'Paste a run link or id');
    const jump = () => {
        const id = runIdFromText(text);
        if (!id) { setInvalid(true); return; }
        setInvalid(false);
        setText('');
        onJump(id);
        onDone?.();
    };
    return (
        <div className="relative">
            <Search size={12} aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
                type="text"
                value={text}
                // Focus moves into the popover it opens with.
                autoFocus={autoFocus}
                onChange={(e) => { setText(e.target.value); if (invalid) setInvalid(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') jump(); }}
                placeholder={label}
                aria-label={label}
                aria-invalid={invalid || undefined}
                className={`w-full min-w-[13rem] pl-7 pr-2 py-1 rounded-lg text-xs bg-[var(--bg-secondary)] border text-[var(--text-primary)] focus:outline-none ${invalid ? 'border-[var(--error)]' : 'border-[var(--border-default)]'}`}
            />
        </div>
    );
}

/** The jump box folded into one icon; the box opens under it. */
export function JumpButton(props: { onJump: (runId: string) => void; runIdFromText: (text: string) => string | null }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const label = t('runs.log.jump_open', 'Open a run from its link');
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={label}
                title={label}
                data-testid="executions-jump-button"
                className="inline-flex items-center justify-center h-7 w-7 rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
            >
                <Link2 size={14} aria-hidden />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={288} role="dialog" aria-label={label} className="p-2">
                <JumpBox {...props} autoFocus onDone={() => setOpen(false)} />
            </AnchoredMenu>
        </>
    );
}

import React, { useCallback, useEffect, useRef } from 'react';

/**
 * Shared chrome of the automation Settings page (handoff 5, artboards 5b/5e):
 * section headings, the 180px label column, button looks, and the debounced
 * autosave every text field on the page uses. The page saves by itself; only
 * a dialog with its own "Save" button waits for a click.
 */

export type SaveFn = (patch: Record<string, unknown>) => Promise<unknown> | unknown;

/** The builder's automation row, as far as the Settings page reads it. */
export interface SettingsAutomation {
    id?: string;
    title?: string;
    description?: string | null;
    icon?: string | null;
    folderId?: string | null;
    isActive?: boolean;
    definition?: Record<string, unknown> | null;
    [key: string]: unknown;
}

// Primary = the accent, never the design's ink fill (owner rule).
export const PRIMARY_BTN = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 disabled:opacity-50 transition';
export const SECONDARY_BTN = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 transition';
export const LINK_BTN = 'inline-flex items-center gap-1 text-[12px] underline underline-offset-2 hover:opacity-80';
export const FIELD = 'w-full px-2.5 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]';
export const SELECT = 'px-2 py-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] text-[var(--text-primary)]';

export function SectionHeading({ id, children, aside }: { id?: string; children: React.ReactNode; aside?: React.ReactNode }) {
    return (
        <div className="flex items-baseline gap-2 flex-wrap">
            <h2 id={id} className="text-[15px] font-semibold text-[var(--text-primary)]">{children}</h2>
            {aside && <span className="text-[12px] text-[var(--text-tertiary)]">{aside}</span>}
        </div>
    );
}

/** The 180px label column + field grid, folding to one column when narrow. */
export function FieldGrid({ children }: { children: React.ReactNode }) {
    return (
        <div className="@container/fields">
            <div className="grid grid-cols-1 @[560px]/fields:grid-cols-[180px_minmax(0,1fr)] gap-x-5 gap-y-3 items-start text-[12px]">
                {children}
            </div>
        </div>
    );
}

export function FieldLabel({ htmlFor, children, hint }: { htmlFor?: string; children: React.ReactNode; hint?: React.ReactNode }) {
    return (
        <label htmlFor={htmlFor} className="pt-2 font-medium text-[var(--text-primary)]">
            {children}
            {hint && <div className="mt-0.5 font-normal leading-[15px] text-[var(--text-tertiary)]">{hint}</div>}
        </label>
    );
}

/** A two-or-more option segmented choice drawn like the artboard's pills. */
export function Choice<T extends string>({ value, options, onChange, label }: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (next: T) => void;
    label: string;
}) {
    return (
        <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-[var(--bg-tertiary)] p-[3px] gap-0.5">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={value === o.value}
                    onClick={() => onChange(o.value)}
                    className={`px-3 py-1 rounded-md text-[12px] font-medium transition ${value === o.value
                        ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/**
 * Debounced autosave for a text field. `schedule(value)` restarts the timer;
 * `flush()` saves right away (on blur). A pending save is flushed on unmount,
 * so leaving the tab mid-typing does not drop the last characters.
 */
export function useDebouncedSave<T>(save: (value: T) => void, delayMs = 700) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pending = useRef<{ value: T } | null>(null);
    const saveRef = useRef(save);
    saveRef.current = save;

    const flush = useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const p = pending.current;
        pending.current = null;
        if (p) saveRef.current(p.value);
    }, []);

    const schedule = useCallback((value: T) => {
        pending.current = { value };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, delayMs);
    }, [delayMs, flush]);

    useEffect(() => flush, [flush]);
    return { schedule, flush };
}

/**
 * One queue for every save on the page, with definition patches rebased.
 *
 * Each section builds `{ definition: { ...automation.definition, [key]: v } }`
 * from the row it was rendered with. Two saves from different sections in
 * quick succession (the retry select, then the concurrency choice, before the
 * first PUT answered) would each carry the OTHER key's old value, and the
 * second PUT would undo the first. So saves run one at a time, and a
 * definition patch only contributes the keys it actually changed, laid over
 * the definition the previous save sent.
 */
export function useQueuedSave(onSave: SaveFn, definition: Record<string, unknown> | null | undefined): (patch: Record<string, unknown>) => Promise<unknown> {
    const propRef = useRef(definition ?? null);
    const latestRef = useRef(definition ?? null);
    const pending = useRef(0);
    const chain = useRef<Promise<unknown>>(Promise.resolve());
    const saveRef = useRef(onSave);
    useEffect(() => { saveRef.current = onSave; }, [onSave]);
    // A new row from the server (a save's answer, the canvas, the AI builder)
    // is the base again once nothing of ours is still on its way.
    useEffect(() => {
        propRef.current = definition ?? null;
        if (pending.current === 0) latestRef.current = definition ?? null;
    }, [definition]);

    return useCallback((patch: Record<string, unknown>) => {
        const seen = propRef.current;
        pending.current += 1;
        const run = async () => {
            let next = patch;
            const def = patch.definition;
            if (def && typeof def === 'object' && !Array.isArray(def)) {
                const changed: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(def as Record<string, unknown>)) {
                    if (!seen || seen[k] !== v) changed[k] = v;
                }
                const merged = { ...(latestRef.current || seen || {}), ...changed };
                latestRef.current = merged;
                next = { ...patch, definition: merged };
            }
            try {
                return await saveRef.current(next);
            } catch (e) {
                // Refused: the next save starts from what the server holds,
                // not from the change it just turned down.
                latestRef.current = propRef.current;
                throw e;
            } finally {
                pending.current -= 1;
            }
        };
        const result = chain.current.then(run, run);
        chain.current = result.catch(() => undefined);
        return result;
    }, []);
}

/**
 * May the viewer change this automation's settings? Owners and editors may
 * (routes: PUT /:id needs `edit`); a row without `myRole` predates sharing,
 * so only its owner could have loaded it.
 */
export function canEditAutomation(a: SettingsAutomation | null | undefined): boolean {
    const role = a?.myRole;
    return role == null || role === 'owner' || role === 'edit';
}

/**
 * Greys out and disables every control inside while the viewer may only
 * look (a `view` or `run` share): the server would refuse each save anyway.
 */
export function ReadOnlyFieldset({ readOnly, children, className = '' }: { readOnly: boolean; children: React.ReactNode; className?: string }) {
    return (
        <fieldset disabled={readOnly} className={`min-w-0 border-0 p-0 m-0 ${readOnly ? 'opacity-70' : ''} ${className}`}>
            {children}
        </fieldset>
    );
}

/** The automation definition with one key replaced, ready for `onSave`. */
export function withDefinition(automation: SettingsAutomation | null | undefined, key: string, value: unknown) {
    return { definition: { ...(automation?.definition || {}), [key]: value } };
}

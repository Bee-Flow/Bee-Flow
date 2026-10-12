import { X } from 'lucide-react';
import React, { useState } from 'react';
import type { ActionEffect, AppAction, AppScreen, NavigateParam } from './appDefinition';
import { mergeDrafts, splitNamed } from './keyedRows';
import ExpressionInput from './logic/ExpressionInput';
import { INPUT_CLS } from './panels/kit';
import { TOAST_TONES } from './styleKnobMeta';
import useTranslation from '../../../../../hooks/useTranslation';
import IconButton from '../../../../shared/IconButton';
import SegmentedControl from '../../../../shared/SegmentedControl';

type TFn = (key: string, fallback: string, params?: Record<string, string | number>) => string;

const TONE_KEYS: Record<string, [string, string]> = {
    info: ['studio_apps_insp.effects.tone_info', 'Info'],
    success: ['studio_apps_insp.effects.tone_success', 'Success'],
    warning: ['studio_apps_insp.effects.tone_warning', 'Warning'],
    danger: ['studio_apps_insp.effects.tone_danger', 'Danger'],
};

export const toneOptions = (t: TFn): Array<{ value: string; label: string }> =>
    TOAST_TONES.map((tone: string) => {
        const entry = TONE_KEYS[tone];
        return { value: tone, label: entry ? t(entry[0], entry[1]) : tone.charAt(0).toUpperCase() + tone.slice(1) };
    });

/** One editable row: the name as typed, and what it carries. */
type ParamRow = [string, NavigateParam];

/** A row that has no name yet, held at the position it occupies. */
interface ParamDraft {
    at: number;
    row: ParamRow;
}

// keyedRows.js is still JavaScript; these state the contract its header
// describes. They go away when that module becomes TypeScript.
const merge = mergeDrafts as (stored: ParamRow[], drafts: ParamDraft[]) => ParamRow[];
const split = splitNamed as (rows: ParamRow[]) => { named: ParamRow[]; drafts: ParamDraft[] };

// logic/ExpressionInput.jsx is still JavaScript, and its `= null` defaults are
// all TypeScript can see of half its props. This states the ones this editor
// passes; it goes away when that component becomes TypeScript.
const Expression = ExpressionInput as React.ComponentType<{
    variant?: 'block' | 'inline';
    value?: string;
    onChange?: (expr: string) => void;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
}>;

// Mirror of LIMITS.MAX_NAVIGATE_PARAMS (server/appStudio/componentSpecs.js).
const MAX_NAVIGATE_PARAMS = 20;

// ── Effects (onSuccess / onError) ──────────────────────────────────────────

/**
 * Values carried along to the next screen — `navigate.params`, readable there
 * as `screen.params.<name>`.
 *
 * The runtime has resolved these since v2 (useActionRunner.resolveNavParams)
 * and the AI builder writes them, but the inspector rendered only the screen
 * select. So "open THIS ticket" was authorable by the AI and invisible to
 * everyone else — and an author who edited such an action here could not see
 * what was being passed.
 *
 * A param is `{kind:'static', value}` or `{kind:'formula', expr}`. Names are
 * kept as typed; renaming rewrites the key in place so the order survives.
 */
export interface NavigateParamsEditorProps {
    /** `navigate.params`, keyed by the name the next screen reads them under. */
    params: Record<string, NavigateParam> | null | undefined;
    onChange: (params: Record<string, NavigateParam> | null) => void;
    disabled?: boolean;
}

export function NavigateParamsEditor({ params, onChange, disabled }: NavigateParamsEditorProps) {
    const { t } = useTranslation();
    const stored: ParamRow[] = Object.entries(params && typeof params === 'object' ? params : {});
    // Rows added or blanked but not yet named. They cannot live in `params`,
    // which is keyed by name — so they are held here WITH the position they
    // occupy, or clearing a name would make the row jump to the bottom of the
    // list while the author was still typing in it.
    const [drafts, setDrafts] = useState<ParamDraft[]>([]);
    const rows = merge(stored, drafts);
    // The row whose rename was refused because the name is already taken. UI
    // only, and cleared by the next accepted edit.
    const [clash, setClash] = useState<number | null>(null);

    const commit = (next: ParamRow[]) => {
        setClash(null);
        // A BLANK name is a duplicate too — the guard below exempted it, so
        // clearing one row's name and then another collapsed both onto the ''
        // key and threw the first row's value away without a word. Unnamed rows
        // wait here instead, exactly as the flow editor's keyed-bindings field
        // does, and reach `params` only once they have a name of their own.
        const { named, drafts: nextDrafts } = split(next);
        setDrafts(nextDrafts);
        onChange(named.length ? Object.fromEntries(named) : null);
    };

    const setRow = (i: number, name: string, entry: NavigateParam) => {
        // params is an object, so two rows CANNOT share a name: committing a
        // duplicate would collapse them and drop the earlier row's value
        // without a word. Refuse the rename and say so instead.
        if (name && rows.some(([n], j) => j !== i && n === name)) {
            setClash(i);
            return;
        }
        commit(rows.map((r, j) => (j === i ? [name, entry] : r)));
    };

    return (
        <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                {t('studio_apps_insp.effects.values_to_carry', 'Values to carry along')}
            </span>
            {rows.length === 0 ? (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('studio_apps_insp.effects.values_empty', 'Nothing yet — the next screen reads these as')}{' '}
                    <code>screen.params.name</code>.
                </p>
            ) : null}
            {rows.map(([name, entry], i) => {
                const isFormula = entry?.kind === 'formula';
                return (
                    <div key={i} className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2">
                        <div className="flex items-center gap-1.5">
                            <input
                                type="text"
                                className={INPUT_CLS}
                                value={name}
                                onChange={(e) => setRow(i, e.target.value, entry)}
                                placeholder={t('studio_apps_insp.effects.value_name_placeholder', 'recordId')}
                                disabled={disabled}
                                spellCheck={false}
                                aria-label={t('studio_apps_insp.effects.value_name_aria', 'Value {n} name', { n: i + 1 })}
                            />
                            <IconButton
                                ariaLabel={t('studio_apps_insp.effects.remove_value', 'Remove value {n}', { n: i + 1 })}
                                variant="danger"
                                size="sm"
                                disabled={disabled}
                                onClick={() => commit(rows.filter((_, j) => j !== i))}
                            >
                                <X />
                            </IconButton>
                        </div>
                        {isFormula ? (
                            <Expression
                                variant="inline"
                                value={entry.expr || ''}
                                onChange={(expr) => setRow(i, name, { kind: 'formula', expr })}
                                placeholder={t('studio_apps_insp.effects.formula_placeholder', 'e.g. item.id')}
                                ariaLabel={t('studio_apps_insp.effects.value_formula_aria', 'Value {n} formula', { n: i + 1 })}
                                disabled={disabled}
                            />
                        ) : (
                            <div className="flex items-stretch gap-1.5">
                                <input
                                    type="text"
                                    className={INPUT_CLS}
                                    value={entry?.value ?? ''}
                                    onChange={(e) => setRow(i, name, { kind: 'static', value: e.target.value })}
                                    placeholder={t('studio_apps_insp.effects.fixed_value_placeholder', 'A fixed value')}
                                    disabled={disabled}
                                    aria-label={t('studio_apps_insp.effects.value_n_aria', 'Value {n}', { n: i + 1 })}
                                />
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => setRow(i, name, isFormula ? { kind: 'static', value: '' } : { kind: 'formula', expr: '' })}
                            disabled={disabled}
                            className="self-start inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        >
                            {isFormula
                                ? t('studio_apps_insp.effects.use_fixed_value', 'Use a fixed value')
                                : t('studio_apps_insp.effects.use_formula', 'Work it out with a formula')}
                        </button>
                        {clash === i ? (
                            <span className="text-[11px] text-[var(--error)]">
                                {t('studio_apps_insp.effects.name_clash', 'Another value already goes by that name — pick a different one.')}
                            </span>
                        ) : null}
                    </div>
                );
            })}
            <button
                type="button"
                onClick={() => commit([...rows, ['', { kind: 'formula', expr: '' }]])}
                disabled={disabled || rows.length >= MAX_NAVIGATE_PARAMS}
                title={rows.length >= MAX_NAVIGATE_PARAMS ? t('studio_apps_insp.effects.max_values', 'At most {max} values.', { max: MAX_NAVIGATE_PARAMS }) : undefined}
                className="self-start px-2.5 py-1 text-[11px] font-medium rounded border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
            >
                {t('studio_apps_insp.effects.carry_value', 'Carry a value along')}
            </button>
        </div>
    );
}

/**
 * "What comes back" — the three moments of a run, read-only.
 *
 * A run_automation action has exactly two authored outcomes today
 * (onSuccess / onError effects) and one that is not authored at all: what
 * happens WHILE it runs. The artboard shows all three, so the author can see
 * that the middle one is handled for them rather than wondering where it went.
 *
 * READ-ONLY on purpose. The editable half is one disclosure below; and the
 * fourth row this eventually wants — what the automation hands BACK to the app,
 * via a `return_to_app` step — does not exist yet (that step is a later
 * stage). Rather than draw an empty row for it and imply it is coming, this
 * says what is true now: the automation decides, and the app is told nothing
 * beyond success or failure.
 */
export interface ReturnedEchoProps {
    action: AppAction;
    screens: AppScreen[];
}

export function ReturnedEcho({ action, screens }: ReturnedEchoProps) {
    const { t } = useTranslation();
    const nameOf = (screenId: string) => screens.find((sc) => sc.id === screenId)?.name || screenId;

    const describe = (effect: ActionEffect | null | undefined) => {
        if (!effect || typeof effect !== 'object') return null;
        const parts = [];
        if (effect.toast?.message) {
            parts.push(t('app_studio.inspector.echo_toast', 'shows “{message}”', { message: String(effect.toast.message).slice(0, 40) }));
        }
        if (effect.navigateTo) {
            parts.push(t('app_studio.inspector.echo_navigate', 'goes to {screen}', { screen: nameOf(effect.navigateTo) }));
        }
        return parts.length ? parts.join(', ') : null;
    };

    const rows = [
        {
            key: 'running',
            label: t('app_studio.inspector.echo_while', 'While it runs'),
            // Not authored anywhere — the runtime does it. Saying so is the
            // point of the row: otherwise this looks like a gap to fill in.
            value: t('app_studio.inspector.echo_while_value', 'the control shows it is busy'),
        },
        {
            key: 'done',
            label: t('app_studio.inspector.echo_done', 'Done'),
            value: describe(action.onSuccess),
        },
        {
            key: 'failed',
            label: t('app_studio.inspector.echo_failed', 'Failed'),
            value: describe(action.onError)
                // A failed run ALWAYS toasts, with or without an onError
                // effect — the runtime does that itself.
                || t('app_studio.inspector.echo_failed_value', 'the error is shown'),
        },
    ];

    return (
        <dl className="flex flex-col gap-1 text-[11px]">
            {rows.map((row) => (
                <div key={row.key} className="flex gap-2">
                    <dt className="w-24 shrink-0 text-[var(--text-tertiary)]">{row.label}</dt>
                    <dd className="min-w-0 flex-1 text-[var(--text-secondary)]">
                        {row.value || (
                            <span className="text-[var(--text-muted)]">
                                {t('app_studio.inspector.echo_nothing', 'nothing extra — the automation decides')}
                            </span>
                        )}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

export interface EffectEditorProps {
    /** "When it succeeds" / "When it fails" — the slot this editor writes. */
    label: string;
    effect: ActionEffect | null | undefined;
    screens: AppScreen[];
    /** null when the effect is left empty — the slot is then dropped entirely. */
    onChange: (effect: ActionEffect | null) => void;
    disabled?: boolean;
}

export function EffectEditor({ label, effect, screens, onChange, disabled }: EffectEditorProps) {
    const { t } = useTranslation();
    const toast = effect?.toast || null;
    const set = (patch: ActionEffect) => {
        const next = { ...(effect || {}), ...patch };
        // Keep the object bounded and tidy: drop empty members entirely.
        if (next.toast && !String(next.toast.message || '').trim()) delete next.toast;
        if (!next.navigateTo) delete next.navigateTo;
        onChange(Object.keys(next).length ? next : null);
    };

    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-2.5 flex flex-col gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{label}</span>
            <input
                type="text"
                className={INPUT_CLS}
                value={toast?.message || ''}
                onChange={(e) => set({ toast: { message: e.target.value, tone: toast?.tone || 'info' } })}
                placeholder={t('studio_apps_insp.effects.toast_placeholder', 'Toast message (optional)')}
                disabled={disabled}
                aria-label={t('studio_apps_insp.effects.toast_message_aria', '{label} toast message', { label })}
            />
            {toast?.message ? (
                <SegmentedControl
                    value={toast.tone || 'info'}
                    onChange={(tone) => set({ toast: { message: toast.message, tone } })}
                    options={toneOptions(t)}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.effects.toast_tone_aria', '{label} toast tone', { label })}
                />
            ) : null}
            <select
                className={INPUT_CLS}
                value={effect?.navigateTo || ''}
                onChange={(e) => set({ navigateTo: e.target.value || null })}
                disabled={disabled}
                aria-label={t('studio_apps_insp.effects.navigate_to_aria', '{label} navigate to', { label })}
            >
                <option value="">{t('studio_apps_insp.effects.stay_on_screen', 'Stay on this screen')}</option>
                {screens.map((s) => (
                    <option key={s.id} value={s.id}>{t('studio_apps_insp.effects.go_to', 'Go to {screen}', { screen: s.name || s.id })}</option>
                ))}
            </select>
        </div>
    );
}

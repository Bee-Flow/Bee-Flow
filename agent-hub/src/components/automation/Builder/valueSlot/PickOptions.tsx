import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Repeat, SquareFunction } from 'lucide-react';
import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import {
    createResolver, inlineText, MAPPING_VERSION, optionsFor, renderText, shapeOf, walkSource,
} from '@shared/mapping/index.mjs';
import type { MappingSource, PickIntent, PickOption, Shape, Slot } from '@shared/mapping/index.mjs';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * How a picked value is used, chosen from what fits the value and the field
 * (core optionsFor): "All, one per line", "All, with commas", "Only the
 * first", "The number", … Each choice shows what the field would get, LIVE:
 * the pick is resolved by the same core the run uses (createResolver), on
 * the sample (or the last run) the editor has. So a table shows one row per
 * line ("Stoel · 1 · 99.5"), never JSON and never "[object Object]", and a
 * list that was empty in the sample is rendered by what it holds at run time.
 *
 * "Advanced" holds what most people never need: a formula instead of a pick,
 * exactly one row of a list, and (wired by the per-item work, M6) the
 * shortcut to run the step once per item.
 */

const resolver = createResolver({ evaluate, parse });

const PREVIEW_MAX = 160;

/** What a resolved value looks like in one or two lines of grey text, or null for nothing. */
export function previewText(value: unknown): string | null {
    if (value === undefined) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else if (Array.isArray(value)) text = inlineText(value);
    else if (value !== null && typeof value === 'object') text = renderText(value, { join: 'comma' });
    else text = value === null ? '' : String(value);
    return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/** The value a pick of `source` with this intent gives on the sample. */
export function resolvePreview(source: MappingSource, intent: PickIntent, sample: object | null | undefined): unknown {
    if (!sample) return undefined;
    const pick = { kind: 'pick', v: MAPPING_VERSION, from: source, ...intent };
    return resolver.resolveValue(pick, sample, { silent: true });
}

export interface PickOptionsProps {
    source: MappingSource;
    /** The runState the previews resolve against: the sample, or the last run. */
    sample?: object | null;
    /** What the field wants (core slotShape). */
    slot?: Partial<Slot> | null;
    /** The source's shape, when the caller knows it better than the sample does. */
    shape?: Shape;
    /** The current choice; the default (the first option) when absent. */
    value?: PickIntent | null;
    /** The value's name, for the heading. */
    label?: string;
    /** The step repeats over this source: offer "one per run, for each item". */
    repeating?: boolean;
    onSelect: (intent: PickIntent) => void;
    /** Advanced › Formula: edit the value as a formula instead. */
    onFormula?: () => void;
    /** Advanced › Exactly this row (0-based). */
    onRowIndex?: (index: number) => void;
    /** Advanced › run the step for each item. Wired by M6; hidden without it. */
    onRepeatShortcut?: () => void;
}

const sameIntent = (a: PickIntent, b: PickIntent | null | undefined) =>
    !!b && a.take === b.take && a.as === b.as && (a.join || null) === (b.join || null);

function OptionButton({ option, selected, preview, onSelect }: {
    option: PickOption; selected: boolean; preview: string | null; onSelect: (intent: PickIntent) => void;
}) {
    const { t } = useTranslation();
    const example = preview === null
        ? t('mapping.slot.options.no_example', 'No example yet')
        : preview === '' ? t('mapping.slot.options.empty_example', '(empty)') : preview;
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            data-option={option.id}
            onClick={() => onSelect({ take: option.take, as: option.as, ...(option.join ? { join: option.join } : {}) })}
            className={`flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition ${
                selected
                    ? 'bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
        >
            <span className="font-medium">{t(`mapping.slot.options.${option.id}`, option.id)}</span>
            {option.take !== 'each' && (
                <span data-testid="option-preview" className="line-clamp-3 whitespace-pre-line break-words text-[11px] text-[var(--text-tertiary)]">
                    {example}
                </span>
            )}
        </button>
    );
}

const ADVANCED_ACTION = 'inline-flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]';

function RowIndex({ onRowIndex }: { onRowIndex: (index: number) => void }) {
    const { t } = useTranslation();
    const [row, setRow] = useState('1');
    const label = t('mapping.slot.options.row', 'Exactly this row');
    const apply = () => {
        const n = Number.parseInt(row, 10);
        if (Number.isSafeInteger(n) && n >= 1) onRowIndex(n - 1);
    };
    return (
        <div className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
            <span>{label}</span>
            <input
                type="number"
                min={1}
                aria-label={label}
                value={row}
                onChange={(e) => setRow(e.target.value)}
                className="w-14 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-1 py-0.5 text-[var(--text-primary)]"
            />
            <button type="button" onClick={apply} className="rounded px-1.5 py-0.5 underline underline-offset-2 hover:text-[var(--text-primary)]">
                {t('mapping.slot.options.row_apply', 'Use row')}
            </button>
        </div>
    );
}

/** Advanced, collapsed until asked for: Formula, one row, and the repeat shortcut. */
function AdvancedSection({ onFormula, onRowIndex, onRepeatShortcut }: Pick<PickOptionsProps, 'onFormula' | 'onRowIndex' | 'onRepeatShortcut'>) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <div className="border-t border-[var(--border-subtle)] pt-1">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(v => !v)}
                className="inline-flex items-center gap-1 px-1 py-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
                {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                {t('mapping.slot.options.advanced', 'Advanced')}
            </button>
            {open && (
                <div className="flex flex-col gap-1 pl-4 pt-1">
                    {onFormula && (
                        <button type="button" onClick={onFormula} className={ADVANCED_ACTION}>
                            <SquareFunction size={12} aria-hidden="true" />
                            {t('mapping.slot.options.formula_hint', 'Write a formula instead')}
                        </button>
                    )}
                    {onRowIndex && <RowIndex onRowIndex={onRowIndex} />}
                    {onRepeatShortcut && (
                        <button type="button" onClick={onRepeatShortcut} className={ADVANCED_ACTION}>
                            <Repeat size={12} aria-hidden="true" />
                            {t('mapping.slot.options.repeat', 'Run this step separately for each item')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export default function PickOptions({
    source, sample, slot, shape, value, label, repeating = false, onSelect, onFormula, onRowIndex, onRepeatShortcut,
}: PickOptionsProps) {
    const { t } = useTranslation();
    const sourceShape: Shape = useMemo(
        () => shape || (sample ? shapeOf(walkSource(source, sample)) : 'unknown'),
        [shape, sample, source],
    );
    const options: PickOption[] = useMemo(() => optionsFor(sourceShape, slot, { repeat: repeating }), [sourceShape, slot, repeating]);
    const previews = useMemo(
        () => options.map(o => (o.take === 'each' ? null : previewText(resolvePreview(source, o, sample)))),
        [options, source, sample],
    );
    const chosen = options.find(o => sameIntent(o, value)) || (value ? null : options[0]);
    // One row only makes sense of a list.
    const rowIndex = sourceShape === 'list' || sourceShape === 'table' ? onRowIndex : undefined;
    const hasAdvanced = !!(onFormula || rowIndex || onRepeatShortcut);

    return (
        <div data-testid="pick-options" className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] p-2 text-[12px] shadow-[var(--shadow-popover)]">
            <div className="px-1 font-semibold text-[var(--text-primary)]">
                {t('mapping.slot.options.title', 'How should {label} be used?', { label: label || t('mapping.slot.label.value', 'Value') })}
            </div>
            <div role="radiogroup" className="flex flex-col gap-0.5">
                {options.map((o, i) => (
                    <OptionButton key={o.id} option={o} selected={chosen === o} preview={previews[i]} onSelect={onSelect} />
                ))}
            </div>
            {hasAdvanced && <AdvancedSection onFormula={onFormula} onRowIndex={rowIndex} onRepeatShortcut={onRepeatShortcut} />}
        </div>
    );
}

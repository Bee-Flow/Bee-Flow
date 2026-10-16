import { FunctionSquare, Plus, Workflow } from 'lucide-react';
import React from 'react';
import BindingField from './BindingField';
import ListPickChooser from './ListPickChooser';
import MismatchResolver from './MismatchResolver';
import { ExampleLine, FormulaChips } from './ValueBuilderParts';
import { pathListShape } from './listShape';
import { kindAtPath } from './mismatch';
import TransformArg from './TransformArg';
import { TRANSFORM_BY_ID, VALUE_TRANSFORMS } from './valueParts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { humanizeFieldKey } from '../flow/displayHelpers';
import { controlSurfaceClass, listBadgeClass, AMBER_NOTE, FOCUS_RING, INLINE_LINK } from '../flow/settings/formStyles';
import type { ReactNode } from 'react';
import type { ListShape } from './listShape';
import type { Remedy } from './mismatch.types';
import type { ValueTransform } from './valueParts';

type LabelMap = Map<string, string>;

/** The "this step now runs once per row" note shown after a forEach pick. */
export interface ForeachNoteState {
    runs?: number | null;
    noun?: string;
    orphans?: string[];
}

export function ForeachNote({ note, onUndo }: { note: ForeachNoteState; onUndo: () => void }) {
    const { t } = useTranslation();
    return (
        <div className={`${AMBER_NOTE} flex items-center gap-2`}>
            <span>
                {note.noun
                    ? t('automations.builder.foreach_deepened_note', 'This step now runs once per {item}, across every one it read before.', { item: humanizeFieldKey(note.noun).toLowerCase() })
                    : note.runs === 1
                        ? t('automations.builder.foreach_set_note_one', 'This step now runs once per row — 1 run.')
                        : t('automations.builder.foreach_set_note', 'This step now runs once per row — {n} runs.', { n: note.runs ?? '?' })}
                {note.orphans && note.orphans.length > 0 && (
                    <> {t('automations.builder.foreach_deepened_orphans', 'Check {fields}: it has no match in the new item.', { fields: note.orphans.join(', ') })}</>
                )}
            </span>
            <button type="button" onClick={onUndo} className="underline hover:no-underline">
                {t('automations.builder.undo', 'Undo')}
            </button>
        </div>
    );
}

interface TransformRowProps {
    /** The one picked data path the transform applies to. */
    path: string | undefined;
    sampleRoot: unknown;
    transform: string | null;
    transformArg: string | null;
    transformArg2: string | null;
    /** (transform, arg, arg2) — the whole new transform state. */
    onTransform: (transform: string | null, arg: string | null, arg2: string | null) => void;
}

/** The "Use it as / Adjust it" row: transform menu, its argument, the list badge. */
export function TransformRow({ path, sampleRoot, transform, transformArg, transformArg2, onTransform }: TransformRowProps) {
    const { t } = useTranslation();
    // A list-resolving pick reads "Use it as:" and sorts the
    // choices for the KIND the pick actually has first — a number
    // leads with "as an amount", a table with "as a table"
    // (artboard 2c). `for` orders and annotates, it NEVER removes
    // an entry (sample data is often missing or wrong).
    const pickedShape = pathListShape(path, sampleRoot);
    const pickedKind = kindAtPath(path, sampleRoot);
    const rank = (tr: ValueTransform) => (tr.for === pickedKind ? 0 : tr.for === 'any' ? 1 : 2);
    const ordered = pickedKind === 'unknown'
        ? VALUE_TRANSFORMS
        : [...VALUE_TRANSFORMS].sort((a, b) => rank(a) - rank(b));
    return (
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)] flex-wrap">
            {pickedShape
                ? t('automations.builder.use_it_as', 'Use it as:')
                : t('automations.builder.adjust_it', 'Adjust it:')}
            <select
                aria-label={t('automations.builder.adjust_aria', 'Adjust the value')}
                value={transform || ''}
                onChange={(e) => {
                    // A fresh transform starts from ITS OWN default
                    // argument, never from the previous one — a
                    // separator is not a date notation.
                    const next = e.target.value || null;
                    const spec: ValueTransform | null = next ? TRANSFORM_BY_ID[next] : null;
                    onTransform(next, spec?.argDefault ?? null, spec?.arg2Default ?? null);
                }}
                className={controlSurfaceClass('px-1.5 py-0.5 text-[11px]')}
            >
                <option value="">{t('automations.builder.use_as_is', 'use it as it is')}</option>
                {ordered.map(tr => (
                    <option key={tr.id} value={tr.id} title={tr.hint}>{tr.label}</option>
                ))}
            </select>
            <TransformArg
                transform={transform}
                arg={transformArg}
                arg2={transformArg2}
                onChange={(a, b) => onTransform(transform, a, b)}
            />
            {pickedShape && !transform && (
                <span className={listBadgeClass()} title={pickedShape.explainEn}>
                    {pickedShape.count != null ? `${t('automations.builder.list_word', 'list')} · ${pickedShape.count}` : t('automations.builder.list_word', 'list')}
                </span>
            )}
        </label>
    );
}

interface ValueActionsProps {
    jsonOnly: boolean;
    hasData: boolean;
    showAddText: boolean;
    showFormula: boolean;
    emptyNote: ReactNode;
    onAddData: React.MouseEventHandler<HTMLButtonElement>;
    onAddText: () => void;
    onFormula: () => void;
}

/** The row under the parts: add data, add text, the empty-slot note, the formula escape. */
export function ValueActions({ jsonOnly, hasData, showAddText, showFormula, emptyNote, onAddData, onAddText, onFormula }: ValueActionsProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-4 flex-wrap pt-0.5">
            {!jsonOnly && (
                <button
                    type="button"
                    onClick={onAddData}
                    className={`flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded ${FOCUS_RING}`}
                >
                    {/* The first pick is the headline action; once something
                        is bound, picking again APPENDS — so it reads as an add. */}
                    <Workflow size={11} /> {hasData
                        ? t('automations.builder.add_data', 'Add data')
                        : t('automations.builder.use_data_from_step', 'Use data from a step')}
                </button>
            )}
            {showAddText && (
                <button
                    type="button"
                    onClick={onAddText}
                    className={`flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded ${FOCUS_RING}`}
                >
                    <Plus size={11} /> {t('automations.builder.add_text', 'Add text')}
                </button>
            )}
            {emptyNote}
            {showFormula && (
                <button
                    type="button"
                    onClick={onFormula}
                    title={t('automations.builder.write_as_formula', 'Write this value as a formula')}
                    aria-label={t('automations.builder.write_as_formula', 'Write this value as a formula')}
                    className={`ml-auto flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded ${FOCUS_RING}`}
                >
                    {/* The visible word, not just the tooltip: this button
                        had its title and aria-label translated while the
                        label itself stayed English, so a Dutch workspace
                        read a Dutch tooltip over an English button.
                        `mode_formula_word` is the same word BindingField's
                        mode toggle already uses (conventions §1.3.1: the
                        key exists, so use it). */}
                    <FunctionSquare size={11} /> {t('automations.builder.mode_formula_word', 'Formula')}
                </button>
            )}
        </div>
    );
}

interface UnsupportedValueProps {
    chrome: ReactNode;
    formulaText: string;
    stepLabelById: LabelMap;
    stepTypeById: LabelMap;
    example: string | null;
    onEdit: () => void;
    onReplace: () => void;
    pickerNode: ReactNode;
}

/** A hand-written expression: read-only with step names resolved, plus the way out. */
export function UnsupportedValue({ chrome, formulaText, stepLabelById, stepTypeById, example, onEdit, onReplace, pickerNode }: UnsupportedValueProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1">
            {chrome}
            <div className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/50 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5">{t('automations.builder.custom_formula', 'Custom formula')}</div>
                <FormulaChips text={formulaText} stepLabelById={stepLabelById} stepTypeById={stepTypeById} />
            </div>
            {example != null && <ExampleLine value={example} />}
            <div className="flex items-center gap-3 text-[10px]">
                <button type="button" onClick={onEdit} className={INLINE_LINK}>
                    {t('automations.builder.edit_formula', 'Edit the formula')}
                </button>
                <button
                    type="button"
                    onClick={onReplace}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                    {t('automations.builder.replace_it', 'Replace it')}
                </button>
            </div>
            {pickerNode}
        </div>
    );
}

interface RawValueEditorProps extends React.ComponentProps<typeof BindingField> {
    onBack: () => void;
}

/** The raw binding editor the formula escape opens, with the way back. */
export function RawValueEditor({ onBack, ...fieldProps }: RawValueEditorProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1">
            <BindingField {...fieldProps} />
            <button
                type="button"
                onClick={onBack}
                className={`text-[10px] ${INLINE_LINK}`}
            >
                {t('automations.builder.back_to_simple', 'Back to the simple editor')}
            </button>
        </div>
    );
}


/** A pick that resolved to a list, awaiting the author's answer. */
export interface ListPickState {
    path: string;
    shape: ListShape | null;
    anchorEl: HTMLElement | null;
    index?: number;
}

/** A pick that resolved to a group or a table: the default remedy is already written. */
export interface ResolverState {
    path: string;
    actualKind: string | null;
    expectedKind: string | null;
    selectedId: string;
}

interface ValuePickersProps {
    /** The VariablePicker element, built by the host (its props are untyped JS). */
    variablePicker: ReactNode;
    sampleRoot: unknown;
    stepLabelById: LabelMap;
    label: string | null;
    resolver: ResolverState | null;
    showResolver: boolean;
    allowForEach: boolean;
    expectShape: string;
    onResolverChoose: (r: Remedy) => void;
    onResolverClose: () => void;
    listPick: ListPickState | null;
    onListChoice: React.ComponentProps<typeof ListPickChooser>['onChoose'];
    onListCancel: () => void;
}

/** The popovers a pick can open: the picker itself, the mismatch box, the list chooser. */
export function ValuePickers(props: ValuePickersProps) {
    const { variablePicker, sampleRoot, stepLabelById, label, resolver, listPick, allowForEach, expectShape } = props;
    return (
        <>
            {variablePicker}
            {resolver && props.showResolver && (
                <MismatchResolver
                    path={resolver.path}
                    sampleRoot={sampleRoot}
                    stepLabelById={stepLabelById}
                    actualKind={resolver.actualKind ?? undefined}
                    expectedKind={resolver.expectedKind ?? undefined}
                    selectedId={resolver.selectedId}
                    allowForEach={allowForEach}
                    onChoose={props.onResolverChoose}
                    onClose={props.onResolverClose}
                />
            )}
            <ListPickChooser
                open={!!listPick}
                anchorEl={listPick?.anchorEl ?? null}
                path={listPick?.path ?? ''}
                shape={listPick?.shape ?? null}
                sampleRoot={sampleRoot}
                stepLabelById={stepLabelById}
                expectShape={expectShape}
                allowForEach={allowForEach}
                fieldLabel={label}
                onChoose={props.onListChoice}
                onCancel={props.onListCancel}
            />
        </>
    );
}

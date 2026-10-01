import { useMemo, useRef, useState, type ComponentType, type DragEvent, type ReactNode } from 'react';
import { Workflow } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { getBindingDropPath as getBindingDropPathJs } from '../mapping/bindingDnd';
import { EmptySlotNote as EmptySlotNoteJs, FieldLabelRow as FieldLabelRowJs } from '../mapping/fieldChrome';
import useVariablePickerJs from '../mapping/useVariablePicker';
import VariablePickerJs from '../mapping/VariablePicker';
import { denseInputClass as denseInputClassJs } from '../flow/settings/formStyles';
import ComposeParts from './ComposeParts';
import type { FieldHandle, InsertOpts } from './fieldHandle';
import PathSlotExtras, { type QuickPick } from './PathSlotExtras';
import PickOptions, { bindingPreviewText } from './PickOptions';
import PickSentence from './PickSentence';
import SlotAdvanced from './SlotAdvanced';
import { onSourceDragOver, readSourceDrop } from './slotDnd';
import { formulaInput, lowerable, type SlotSpec, type SlotStorage } from './slotModel';
import { formulaSummary } from './usePickLabel';
import { useValueSlot, type PickInfo } from './useValueSlot';
import ValueChip from './ValueChip';

type AnyComponent = ComponentType<Record<string, unknown>>;
const EmptySlotNote = EmptySlotNoteJs as unknown as AnyComponent;
const FieldLabelRow = FieldLabelRowJs as unknown as AnyComponent;
const VariablePicker = VariablePickerJs as unknown as AnyComponent;
const denseInputClass = denseInputClassJs as (extra?: string) => string;
const getBindingDropPath = getBindingDropPathJs as (e: DragEvent) => string | null;
const useVariablePicker = useVariablePickerJs as () => {
    open: boolean;
    openPicker: (el: Element | null | undefined, opts?: Record<string, unknown>) => void;
    closePicker: () => void;
    pickerProps: Record<string, unknown>;
};

export interface ValueSlotProps extends SlotSpec {
    value: unknown;
    onChange: (next: unknown) => void;
    /** How the value is stored (slotModel): a binding (default), a legacy-only binding, or a path string. */
    storage?: SlotStorage;
    /** The field's human name. */
    label?: string | null;
    /** Unique within the step: how "Where should this go?" names the field. */
    fieldId?: string;
    required?: boolean;
    hint?: ReactNode;
    autoMapped?: boolean;
    /** Draw the label row and the empty-required note. */
    showChrome?: boolean;
    placeholder?: string | null;
    /** Offer Advanced › Formula (always there for a value that already is a formula). */
    allowRaw?: boolean;
    /** A value may be typed (default). A list field of a collection step may not. */
    allowTyping?: boolean;
    previewSample?: object | null;
    onFocusField?: ((handle: FieldHandle) => void) | null;
    disabled?: boolean;
    /** path storage: the field wants a list (amber when the value is not one). */
    expectArray?: boolean;
    /** path storage: suggestions under the field (lists found upstream). */
    quickPicks?: QuickPick[] | null;
    quickPicksLabel?: string | null;
}

/**
 * One value for one field, the way a person thinks of it: typed, or picked
 * from "Comes in". A picked value is a chip with its name and an example
 * ("E-mail of customer  anna@voorbeeld.nl"), never a path; a list says what
 * the field will get in one sentence ("Comes as text: all 12, one per line.
 * Change"), and Change offers the choices with live previews (PickOptions).
 *
 * A value arrives by a click in "Comes in" (when this field has focus, or
 * was chosen in "Where should this go?"), a drop, or the field's own "Use
 * data from a step". All three end in useValueSlot.accept. A pick into a
 * field that holds one value REPLACES it, with "Replaced · Undo"; a pick
 * into typed text in a text field keeps the text.
 *
 * A stored legacy reference shows as the chip it lifts to and is rewritten
 * only when the user changes it; anything else shows as the grey "Formula"
 * chip and is edited under Advanced › Formula, exactly as stored.
 */
export default function ValueSlot(props: ValueSlotProps) {
    const {
        value, onChange, storage = 'binding', label = null, required = false, hint = null, autoMapped = false,
        showChrome = false, placeholder = null, allowRaw = true, allowTyping = true, disabled = false,
        expectKind = null, multiLine = false, previewSample = null, onFocusField = null,
        expectArray = false, quickPicks = null, quickPicksLabel = null,
    } = props;
    const s = useValueSlot({ ...props, storage, label, required, previewSample, onFocusField });
    const { t, view, pickInfo } = s;
    const picker = useVariablePicker();
    const [formula, setFormula] = useState(false);
    const [optionsOpen, setOptionsOpen] = useState(false);
    const [typing, setTyping] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const ph = placeholder ?? t('mapping.slot.placeholder', 'Type a value, or pick one from Comes in');

    // Advanced › Formula edits a pick or a compose in its legacy spelling;
    // one that has none (a bulleted text, per item) offers no Formula.
    const canFormula = useMemo(() => formulaInput(value, storage, s.sample) !== null, [value, storage, s.sample]);

    // A drag from the builder carries the value as a Source and as its legacy
    // path. The Source is taken when a pick can hold it; the path keeps its
    // [*] for the legacy spellings, and is the value when no Source came.
    const onDrop = (e: DragEvent) => {
        const dragged = readSourceDrop(e);
        const path = getBindingDropPath(e);
        if (!dragged && !path) return;
        e.stopPropagation();
        if (dragged) s.accept(dragged, path);
        else if (path) s.acceptPath(path);
    };
    const onPick = (path: string, opts: InsertOpts = {}) => {
        picker.closePicker();
        s.acceptPath(path, opts);
    };
    const openPicker = (el: Element | null) => picker.openPicker(el || rootRef.current);

    const chrome = showChrome
        ? <FieldLabelRow label={label} required={required} expectKind={expectKind} hint={hint} autoMapped={autoMapped} />
        : null;
    const advanced = (
        <SlotAdvanced
            editing={formula}
            onEditingChange={setFormula}
            value={value}
            onChange={onChange}
            storage={storage}
            offer={allowRaw && !disabled && canFormula}
            label={label}
            slot={s.slot}
            expectKind={expectKind}
            hint={hint}
            required={required}
            placeholder={ph}
            multiline={multiLine}
            previewSample={s.sample}
            onFocusField={onFocusField}
        />
    );
    if (formula && canFormula) return <div className="space-y-1" data-testid="value-slot">{chrome}{advanced}</div>;

    let body: ReactNode;
    if (view.kind === 'pick' && pickInfo) {
        body = (
            <PickView
                info={pickInfo}
                storage={storage}
                slotProps={s}
                label={label}
                disabled={disabled}
                optionsOpen={optionsOpen}
                setOptionsOpen={setOptionsOpen}
                onRepick={() => openPicker(null)}
                onFormula={allowRaw && canFormula ? () => { setOptionsOpen(false); setFormula(true); } : undefined}
            />
        );
    } else if (view.kind === 'compose') {
        body = (
            <ComposeParts
                compose={view.compose}
                onChange={onChange}
                sample={s.sample}
                slot={s.slot}
                groups={s.groups}
                stepLabelById={s.stepLabelById}
                onFocus={s.onFocus}
                disabled={disabled}
            />
        );
    } else if (view.kind === 'formula' && !typing) {
        body = <FormulaView binding={view.binding} slotProps={s} disabled={disabled} onOpen={() => setFormula(true)} />;
    } else {
        const text = view.kind === 'literal' ? view.text : view.kind === 'formula' ? String((view.binding as { value?: unknown }).value ?? '') : '';
        const typed = {
            value: text,
            disabled,
            onFocus: () => setTyping(true),
            onBlur: () => setTyping(false),
            placeholder: ph,
            'aria-label': label || t('mapping.slot.label.value', 'Value'),
            className: denseInputClass('w-full'),
        };
        if (!allowTyping && !text) body = null;
        else if (s.slot.multiLine) body = <textarea {...typed} rows={3} onChange={(e) => s.setText(e.target.value)} />;
        else body = <input type="text" {...typed} onChange={(e) => s.setText(e.target.value)} />;
    }

    return (
        <div
            ref={rootRef}
            className="space-y-1"
            data-testid="value-slot"
            data-view={view.kind}
            onFocusCapture={s.onFocus}
            onDragOver={onSourceDragOver}
            onDrop={onDrop}
        >
            {chrome}
            {body}
            {(view.kind !== 'pick' || storage === 'path') && !disabled && (
                <div className="flex items-center gap-3 flex-wrap">
                    <button
                        type="button"
                        onClick={(e) => openPicker(e.currentTarget)}
                        className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
                    >
                        <Workflow size={11} aria-hidden="true" />
                        {view.kind === 'compose'
                            ? t('mapping.slot.add_value', 'Add a value from a step')
                            : t('mapping.slot.use_data', 'Use data from a step')}
                    </button>
                    {view.kind !== 'formula' && <span className="ml-auto">{advanced}</span>}
                </div>
            )}
            {s.toast && (
                <div role="status" className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]" data-testid="slot-replaced">
                    <span>{t('mapping.slot.replaced', 'Replaced')}</span>
                    <span aria-hidden="true">·</span>
                    <button type="button" onClick={s.undo} className="font-semibold underline underline-offset-2 hover:text-[var(--text-primary)]">
                        {t('mapping.slot.undo', 'Undo')}
                    </button>
                </div>
            )}
            {storage === 'path' && (
                <PathSlotExtras
                    info={pickInfo}
                    value={typeof value === 'string' ? value : ''}
                    expectArray={expectArray}
                    quickPicks={quickPicks}
                    quickPicksLabel={quickPicksLabel}
                    sample={s.sample}
                    stepLabelById={s.stepLabelById}
                    onPick={(path) => s.acceptPath(path)}
                />
            )}
            {showChrome && (
                <EmptySlotNote expectKind={expectKind} required={required} empty={view.kind === 'empty'} onPick={(e?: { currentTarget?: Element }) => openPicker(e?.currentTarget || null)} />
            )}
            <VariablePicker
                {...picker.pickerProps}
                groups={s.groups}
                previewSample={s.sample}
                onPick={onPick}
                title={label
                    ? t('routines.builder.pick_data_for', 'Pick data for {field}', { field: label })
                    : t('routines.builder.pick_data', 'Pick data from a step')}
            />
        </div>
    );
}

/** A stored value that is no pick: the grey Formula chip, in words, with what it gives on the sample. */
function FormulaView({ binding, slotProps: s, disabled, onOpen }: {
    binding: unknown;
    slotProps: ReturnType<typeof useValueSlot>;
    disabled: boolean;
    onOpen: () => void;
}) {
    const { t } = useTranslation();
    // Resolved by the same core as the run, so the example is what the field gets.
    const preview = useMemo(() => bindingPreviewText(binding, s.sample), [binding, s.sample]);
    return (
        <ValueChip
            state="formula"
            label={t('mapping.slot.formula', 'Formula')}
            summary={formulaSummary(t, binding as { kind?: string }, s.stepLabelById)}
            preview={preview}
            disabled={disabled}
            onOpen={onOpen}
            onRemove={s.clear}
        />
    );
}

/**
 * "· 12" belongs on a chip that hands the list over: "Total of the first
 * orders · 2" reads as two. Its sentence says how many there are.
 */
const chipCount = (info: PickInfo) => (info.pick.take === 'first' || info.pick.take === 'last' ? null : info.count);

/** A picked value: its chip, its sentence, and (on Change) its options. */
function PickView({ info, storage, slotProps, label, disabled, optionsOpen, setOptionsOpen, onRepick, onFormula }: {
    info: PickInfo;
    storage: SlotStorage;
    slotProps: ReturnType<typeof useValueSlot>;
    label: string | null;
    disabled: boolean;
    optionsOpen: boolean;
    setOptionsOpen: (open: boolean | ((o: boolean) => boolean)) => void;
    onRepick: () => void;
    onFormula?: () => void;
}) {
    const { t } = useTranslation();
    const s = slotProps;
    const { pick } = info;
    // A path field holds the list itself: there is nothing to choose about it.
    const choosable = storage !== 'path' && !disabled;
    const toggle = choosable ? () => setOptionsOpen(o => !o) : undefined;
    const rowIndex = (index: number) => { s.pickRow(index); setOptionsOpen(false); };
    return (
        <div className="flex flex-col gap-1">
            <ValueChip
                state={info.stale ? 'stale' : 'ok'}
                label={info.label}
                count={chipCount(info)}
                preview={info.preview}
                disabled={disabled}
                onOpen={toggle}
                onRemove={s.clear}
                onRepick={onRepick}
            />
            {!info.stale && storage !== 'path' && (
                <PickSentence
                    intent={pick}
                    count={info.count}
                    warning={info.warning}
                    onChange={toggle}
                    columns={info.columns?.columns}
                    column={info.columns?.column}
                    onColumn={s.setColumn}
                />
            )}
            {optionsOpen && choosable && (
                <PickOptions
                    source={pick.from}
                    sample={s.sample}
                    slot={s.slot}
                    shape={info.shape}
                    value={pick}
                    label={info.label || label || undefined}
                    canUse={storage === 'legacy' ? lowerable : undefined}
                    note={info.lifted && storage === 'binding'
                        ? t('mapping.slot.upgrade_note', 'This value is saved in the older format. Choosing an option saves it in the new one; each option shows what the field will get.')
                        : null}
                    onSelect={(intent) => { s.selectIntent(intent); setOptionsOpen(false); }}
                    onFormula={onFormula}
                    onRowIndex={storage === 'binding' ? rowIndex : undefined}
                />
            )}
        </div>
    );
}

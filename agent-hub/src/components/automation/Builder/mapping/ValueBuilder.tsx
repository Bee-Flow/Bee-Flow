import { useRef, useState } from 'react';
import { onBindingDragOver } from './bindingDnd';
import previewBinding from './bindingPreview';
import { isEmptyValue } from './boundPaths';
import { EmptySlotNote, FieldLabelRow } from './fieldChrome';
import { useFormRowLabel } from './FormRowLabelContext';
import RefTokenInput from './RefTokenInput';
import { useSlotListAs } from './slotListAs';
import useValuePick, { useValueParts } from './useValuePick';
import useVariablePicker from './useVariablePicker';
import { DataPart, EXAMPLE_MAX, ExampleLine, pathTextOf, TextPart } from './ValueBuilderParts';
import {
    ForeachNote, RawValueEditor, TransformRow, UnsupportedValue, ValueActions, ValuePickers,
} from './ValueBuilderViews';
import { PathAsTextNote } from './ValueNotes';
import { buildValue } from './valueParts';
import VariablePicker from './VariablePicker';
import { useVariablePickerContext } from './VariablePickerContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useFormMode } from '../flow/settings/formDensity';
import { denseInputClass } from '../flow/settings/formStyles';
import type { Binding, ForEachConfig } from './itemRefs';
import type { DeepenHandle } from './deepPick';
import type { OnFocusField } from './focusField.types';

/**
 * VISUAL value editor — the plain-language alternative to BindingField.
 *
 * BindingField is a text box over the raw binding: to reference an earlier
 * step you type (or drop) `{{steps.act_4d4307a.output.total}}`, and to change
 * that value you type `lower(...)` in a second, differently-behaving mode. Both
 * halves show the user an internal step id and a small language nobody
 * announced. This editor shows the same binding as things you can point at:
 *
 *   [gmail search ▸ Total ✕]  adjust: (lowercase ▾)
 *   [Order #][gmail search ▸ Id ✕]           ← several parts = joined text
 *
 * Everything it writes is an ordinary binding (see valueParts.js) — a ref, a
 * literal, a `{{ }}` template, or a one-call expression — so the AI builder,
 * the validator and the runtime see nothing new, and a value built here can
 * still be opened in the raw editor.
 *
 * Values it cannot represent (hand-written expressions) are never rewritten:
 * they render read-only with the step NAMES resolved, plus a way into the raw
 * editor. `allowRaw` (the inspector's full density) decides whether that
 * escape is offered up front.
 */
interface ValueBuilderProps {
    value: Binding | null;
    placeholder?: string | null;
    onFocusField?: OnFocusField | null;
    onChange?: (binding: unknown) => void;
    previewSample?: unknown;
    onRequestForEach?: ((forEach: ForEachConfig | null | undefined) => void) | null;
    listAs?: string | null;
    allowRaw?: boolean;
    label?: string | null;
    expectShape?: string;
    canForEach?: boolean | null;
    deepenForEach?: DeepenHandle | null;
    showChrome?: boolean;
    required?: boolean;
    expectKind?: string | null;
    hint?: string | null;
    autoMapped?: boolean;
    multiline?: boolean;
}

export default function ValueBuilder({
    value,
    onChange,
    // Resolved in the body, not as a default parameter: a default is
    // evaluated before `t` exists, which is how this one string stayed
    // English on every screen that did not pass its own.
    placeholder = null,
    previewSample = null,
    onFocusField = null,
    allowRaw = true,
    label = null,
    // 'list' | 'scalar' | 'unknown' — what the parameter's schema wants
    // (listShape.expectedShapeFor). The chooser gate is POSITIVE: it opens
    // only for 'scalar', so schema-less surfaces (App Studio, custom rows,
    // Set fields) behave exactly as before.
    expectShape = 'unknown',
    // (forEach|null) => void — offered as "run this step once per row".
    // Absent (or the step is in list mode): the choice is simply not shown.
    onRequestForEach = null,
    // May a pick START a forEach here? Defaults to "there is a callback";
    // false while the step already runs per item (useForEachRequest), when
    // the callback stays only so Undo can clear what a pick just set.
    canForEach = null,
    // { itemVar, apply(plan, newItem) => { undo, runs, orphans } } while the
    // step already runs per item: a value from a list INSIDE that item moves
    // the step to that list (deepenForEach.ts). Absent: not offered.
    deepenForEach = null,
    // Slot chrome (mapping/fieldChrome.jsx) — the same label row and
    // empty-required note BindingField draws, so a schema-declared parameter
    // reads identically whichever editor renders it. `label` alone still only
    // names the field for the picker's title; `showChrome` is what draws it.
    showChrome = false,
    required = false,
    expectKind = null,
    hint = null,
    autoMapped = false,
    multiline = false, // honoured by the raw escape; the visual editor grows on its own
    // How the run writes a list into this slot's text ('text' | 'json');
    // defaults to the step's own (slotListAs, provided by SettingsForm).
    listAs = null,
}: ValueBuilderProps) {
    const rowLabel = useFormRowLabel();
    const { t } = useTranslation();
    const pickerCtx = useVariablePickerContext();
    const picker = useVariablePicker();
    const [rawOpen, setRawOpen] = useState(false);
    // Which part the open picker will write into (-1 = append a new one).
    const pickTarget = useRef(-1);
    // "Adjust it", Formula and the other answers for a list/table pick are
    // Advanced: shown inline in the Advanced mode (also outside the step
    // form, where there is no mode), never in Simple. No per-field toggle.
    const advancedOpen = useFormMode() !== 'simple';

    // One placeholder string for every branch below (the raw escape gets it
    // too), so switching editors never changes what the empty box says.
    const ph = placeholder ?? t('automations.builder.type_a_value', 'Type a value…');
    const allowForEach = canForEach ?? !!onRequestForEach;
    const { parsed, parts, setComposing, inline, inlineText, inlineRows, inlineRef, pillTarget, emit, setText, removeAt } = useValueParts(value, onChange);
    const sampleRoot = previewSample ?? pickerCtx.previewSample;
    const slotListAs = useSlotListAs();
    // Room for a sentence: the line wraps to two (ExampleLine), so the deep
    // values of a long text are shown rather than cut after a few words.
    const example = previewBinding(value, sampleRoot, { raw: false, listAs: listAs || slotListAs, maxLen: EXAMPLE_MAX });


    const openPicker = (el: (EventTarget & HTMLButtonElement) | (EventTarget & HTMLElement), index: number, focusPath: string | undefined = '') => { pickTarget.current = index; picker.openPicker(el, focusPath ? { focusPath } : {}); };
    const pick = useValuePick({
        value, onChange, onRequestForEach, deepenForEach, expectShape, expectKind, label, allowForEach, sampleRoot,
        inline, parts, emit, inlineRef, pickTarget, pillTarget, picker, onFocusField, rowLabel,
    });
    const { emitInline, broadcast, onDrop } = pick;

    const pickerNode = (
        <ValuePickers
            variablePicker={(
                <VariablePicker
                    {...picker.pickerProps}
                    groups={pickerCtx.groups}
                    previewSample={sampleRoot}
                    onPick={pick.onPick}
                    onClose={() => { pillTarget.current = null; picker.closePicker(); }}
                    title={label
                        ? t('automations.builder.pick_data_for', 'Pick data for {field}', { field: label })
                        : t('automations.builder.pick_data', 'Pick data from a step')}
                />
            )}
            sampleRoot={sampleRoot}
            stepLabelById={pickerCtx.stepLabelById}
            label={label}
            resolver={pick.resolver}
            showResolver={advancedOpen}
            allowForEach={allowForEach}
            expectShape={expectShape}
            onResolverChoose={pick.onResolverChoose}
            onResolverClose={() => pick.setResolver(null)}
            listPick={pick.listPick}
            onListChoice={pick.onListChoice}
            onListCancel={() => pick.setListPick(null)}
        />
    );

    // The slot's own chrome — drawn identically whichever editor is inside it,
    // including the raw escape below, so switching to the formula never makes
    // the label or the "still empty" note disappear.
    const chrome = showChrome
        ? <FieldLabelRow label={label} required={required} expectKind={expectKind} hint={hint} autoMapped={autoMapped} />
        : null;
    const emptyNote = showChrome
        ? <EmptySlotNote expectKind={expectKind} required={required} empty={isEmptyValue(value)} onPick={(e) => openPicker(e?.currentTarget || null, -1)} />
        : null;

    if (rawOpen) {
        return (
            <RawValueEditor
                value={value}
                onChange={onChange}
                placeholder={ph}
                onFocusField={onFocusField}
                previewSample={sampleRoot}
                label={showChrome ? label : null}
                required={required}
                expectKind={expectKind}
                hint={hint}
                multiline={multiline}
                expectShape={expectShape}
                onRequestForEach={allowForEach ? onRequestForEach : null}
                listAs={listAs}
                onBack={() => setRawOpen(false)}
            />
        );
    }

    if (!parsed.supported) {
        return (
            <UnsupportedValue
                chrome={chrome}
                formulaText={parsed.text}
                stepLabelById={pickerCtx.stepLabelById}
                stepTypeById={pickerCtx.stepTypeById}
                example={example}
                onEdit={() => setRawOpen(true)}
                onReplace={() => onChange?.({ kind: 'literal', value: '' })}
                pickerNode={pickerNode}
            />
        );
    }

    const dataParts = parts.filter(p => p.type === 'data');
    const showTransform = parts.length === 1 && dataParts.length === 1;
    const pathText = pathTextOf(parts);
    // A JSON pick is the whole value (see buildValue) — nothing to combine it
    // with, so the add buttons stand down rather than offering a dead end.
    const jsonOnly = parts.length === 1 && parts[0].type === 'json';
    // An empty value still renders ONE text box — as an element of the same
    // list, so typing the first character doesn't swap a single child for an
    // array and remount the input out from under the caret.
    const viewParts = parts.length ? parts : [{ type: 'text', text: '' }];

    return (
        <div className="space-y-2" onDragOver={onBindingDragOver} onDrop={onDrop}>
            {chrome}
            {inline ? (
                <RefTokenInput
                    ref={inlineRef}
                    value={inlineText}
                    mode="fixed"
                    multiline
                    rows={inlineRows}
                    onChange={emitInline}
                    onFocus={broadcast}
                    onDragOver={onBindingDragOver}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(e); }}
                    placeholder={ph}
                    // With the label drawn above, the box IS the field — naming
                    // it "<label> value" would make a screen reader announce a
                    // second, different control. Matches BindingField.
                    ariaLabel={label
                        ? (showChrome ? label : t('automations.builder.value_of', '{field} value', { field: label }))
                        : t('automations.builder.value_word', 'Value')}
                    stepLabelById={pickerCtx.stepLabelById}
                    stepTypeById={pickerCtx.stepTypeById}
                    onPillClick={({ el, path }) => { pillTarget.current = el; pickTarget.current = -1; picker.openPicker(el, { focusPath: path }); }}
                    className={denseInputClass('w-full')}
                />
            ) : viewParts.map((part, i) => (part.type === 'text' ? (
                <TextPart
                    key={`t${i}`}
                    text={part.text as string}
                    placeholder={ph}
                    onChange={(t) => setText(i, t)}
                    onFocus={broadcast}
                    onRemove={viewParts.length > 1 ? () => removeAt(i) : null}
                />
            ) : (
                <DataPart
                    key={`d${i}`}
                    path={part.path as string}
                    jsonPath={part.type === 'json' ? part.jsonPath : null}
                    transform={showTransform ? parsed.transform : null}
                    transformArg={showTransform ? parsed.transformArg : null}
                    stepLabelById={pickerCtx.stepLabelById}
                    stepTypeById={pickerCtx.stepTypeById}
                    onChange={part.type === 'json' ? null : (e) => openPicker(e.currentTarget, i, part.path)}
                    onRemove={() => removeAt(i)}
                />
            )))}

            <ValueActions
                jsonOnly={jsonOnly}
                hasData={dataParts.length > 0}
                showAddText={!inline && dataParts.length > 0}
                showFormula={allowRaw && advancedOpen}
                emptyNote={emptyNote}
                onAddData={(e) => openPicker(e.currentTarget, -1)}
                onAddText={() => setComposing(true)}
                onFormula={() => setRawOpen(true)}
            />

            {showTransform && advancedOpen && (
                <TransformRow
                    path={dataParts[0]?.path}
                    sampleRoot={sampleRoot}
                    transform={parsed.transform}
                    transformArg={parsed.transformArg}
                    transformArg2={parsed.transformArg2}
                    onTransform={(next, a, b) => emit(parts, next, a, b)}
                />
            )}

            {pick.foreachNote && <ForeachNote note={pick.foreachNote} onUndo={pick.undoForeach} />}

            {example != null && <ExampleLine value={example} />}
            {pathText && <PathAsTextNote onUse={() => onChange?.(buildValue([{ type: 'data', path: pathText }]))} />}
            {pickerNode}
        </div>
    );
}

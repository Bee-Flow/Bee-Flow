import { Eye, FunctionSquare, List, Plus, Repeat, Tag, Workflow, X, Zap } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { onBindingDragOver, getBindingDropPath } from './bindingDnd';
import BindingField from './BindingField';
import previewBinding from './bindingPreview';
import { isEmptyValue } from './boundPaths';
import { EmptySlotNote, FieldLabelRow } from './fieldChrome';
import ListPickChooser from './ListPickChooser';
import { pathListShape } from './listShape';
import { detectMismatch, kindAtPath, remediesFor } from './mismatch';
import MismatchResolver from './MismatchResolver';
import { pillTint, PILL_TINT_CLASS } from './refEditorDom';
import RefTokenInput from './RefTokenInput';
import useVariablePicker from './useVariablePicker';
import {
    buildValue, DATE_FORMATS, describeDataPath, NUMBER_STYLES, parseValue,
    TRANSFORM_BY_ID, VALUE_TRANSFORMS,
} from './valueParts';
import VariablePicker from './VariablePicker';
import { useVariablePickerContext } from './VariablePickerContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import { bindingFromInput, formatPathForInsert } from '../../../../utils/bindingHelpers';
import { controlSurfaceClass, denseInputClass, listBadgeClass, AMBER_NOTE, INLINE_LINK } from '../flow/settings/formStyles';

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
}) {
    const { t } = useTranslation();
    const pickerCtx = useVariablePickerContext();
    const picker = useVariablePicker();
    const [rawOpen, setRawOpen] = useState(false);
    // Which part the open picker will write into (-1 = append a new one).
    const pickTarget = useRef(-1);
    // The list chooser: a pick that resolved to a list, awaiting the user's
    // answer. { path, shape, anchorEl, index } | null.
    const [listPick, setListPick] = useState(null);
    // A pick that resolved to a GROUP or a TABLE: the default remedy is
    // already written and this box asks whether it was the right one.
    // { path, actualKind, expectedKind, selectedId } | null
    const [resolver, setResolver] = useState(null);
    // What to restore if the user presses Undo after a foreach choice.
    const undoRef = useRef(null);
    const [foreachNote, setForeachNote] = useState(null); // { runs } | null

    // One placeholder string for every branch below (the raw escape gets it
    // too), so switching editors never changes what the empty box says.
    const ph = placeholder ?? t('routines.builder.type_a_value', 'Type a value…');
    const parsed = useMemo(() => parseValue(value), [value]);
    const sampleRoot = previewSample ?? pickerCtx.previewSample;
    const example = previewBinding(value, sampleRoot, { raw: false });

    const parts = parsed.parts;
    // ONE text box with the references as pills in it (design 2a: "just
    // type, fields may go in between") whenever the value is text, or text
    // and data mixed. A single picked value keeps its chip and the "use it
    // as" control; "Add text" beside that chip switches to composing.
    const [composing, setComposing] = useState(false);
    const inlineRef = useRef(null);
    // The pill a click is re-picking for (inline mode).
    const pillTarget = useRef(null);
    const singleData = parts.length === 1 && parts[0].type === 'data';
    const inline = parsed.supported && !(parts.length === 1 && parts[0].type === 'json') && (composing || !singleData);
    const inlineText = parts.map(p => (p.type === 'data' ? `{{${p.path}}}` : p.text)).join('');
    const inlineRows = Math.min(12, Math.max(1, inlineText.split('\n').length));
    const emit = (nextParts, nextTransform = parsed.transform, nextArg = parsed.transformArg, nextArg2 = parsed.transformArg2) => {
        // A transform belongs to a single picked value; joining parts drops it
        // (the control that sets it is hidden in that shape anyway).
        const dataCount = nextParts.filter(p => p.type === 'data').length;
        const keep = dataCount === 1 && nextParts.length === 1 ? nextTransform : null;
        onChange?.(buildValue(nextParts, keep, keep ? nextArg : null, keep ? nextArg2 : null));
    };

    const openPicker = (el, index, focusPath = '') => { pickTarget.current = index; picker.openPicker(el, focusPath ? { focusPath } : {}); };
    // The pick pipeline. `opts.raw` (Alt held, or "insert it as it is") skips
    // every question; so does a slot whose shape is unknown — the gate is
    // POSITIVE, so App Studio, custom rows and Set fields behave exactly as
    // they did before this editor learned to ask anything.
    //
    // WHETHER to ask, and WHICH question, comes from mapping/mismatch.js and
    // nowhere else. This used to read `pathListShape` directly, which knows
    // only one shape: a GROUP produced no shape at all and went in silently
    // (the group branch mismatch.js has always carried was unreachable from
    // the default editor), and a TABLE got the LIST menu, whose "join" over
    // rows of objects writes "[object Object]" into an e-mail subject.
    //
    // The answers land in two presenters:
    //   a list, table or group picked INTO the field → the inline resolver
    //           under it, which writes mismatch.js's own default first (join /
    //           asTable / groupSummary) so the field is never left holding the
    //           raw value while the question is on screen;
    //   a list re-picked onto an existing CHIP → ListPickChooser beside that
    //           chip, with its separator control; it writes nothing until
    //           the author answers.
    const proposePick = (path, anchorEl, opts = {}) => {
        const clean = String(path || '').trim();
        if (!clean) return;
        const index = pickTarget.current;
        pickTarget.current = -1;
        if (opts.raw || expectShape !== 'scalar') { insertPath(clean, index, opts.at); return; }
        const actualKind = kindAtPath(clean, sampleRoot);
        // A scalar slot with no declared kind still wants ONE value; 'text' is
        // the widest scalar, so it asks the same question the shape-level rule
        // used to ask and never a narrower one.
        const expectedKind = expectKind && expectKind !== 'unknown' ? expectKind : 'text';
        const mm = detectMismatch({ actualKind, expectedKind });
        if (!mm) { insertPath(clean, index, opts.at); return; }
        if (mm.code === 'list_into_one') {
            // Round 2 leftover (artboard 2a): a list picked into the field
            // (tree click, drag, the picker) answers INLINE, as buttons in the
            // warning box under the field. Re-picking an existing chip keeps
            // the popover beside that chip: the question is about the chip.
            const shape = pathListShape(clean, sampleRoot);
            if (shape && index >= 0) { setListPick({ path: clean, shape, anchorEl: anchorEl || null, index }); return; }
            if (shape && openResolver(clean, actualKind, expectedKind)) return;
            insertPath(clean, index, opts.at);
            return;
        }
        if (!openResolver(clean, actualKind, expectedKind)) insertPath(clean, index, opts.at);
    };
    // Write mismatch.js's own default remedy and open the box that asks
    // whether it was the right one. False when there is no remedy at all — the
    // caller then inserts the path verbatim rather than swallowing the pick.
    const openResolver = (path, actualKind, expectedKind) => {
        const remedies = remediesFor(path, sampleRoot, { allowForEach: !!onRequestForEach, actualKind });
        const first = [...remedies.primary, ...remedies.more].find(r => r.id === remedies.defaultId)
            || remedies.primary[0];
        if (!first) return false;
        applyRemedy(first);
        setResolver({ path, actualKind, expectedKind, selectedId: first.id });
        return true;
    };
    // Write one remedy's binding. A remedy is the WHOLE value (it is an
    // expression over the picked path), so it replaces the parts rather than
    // joining onto them — the same thing BindingField does with applyBinding.
    const applyRemedy = (r) => {
        if (!r) return;
        if (r.id === 'foreach' && onRequestForEach) {
            undoRef.current = { value, forEach: null };
            onRequestForEach(r.forEach);
        }
        onChange?.(r.binding);
    };
    const onResolverChoose = (r) => {
        if (!r) return;
        applyRemedy(r);
        setResolver(prev => (prev ? { ...prev, selectedId: r.id } : prev));
    };
    const insertPath = (path, index, at = null) => {
        if (inline) {
            const snippet = formatPathForInsert(path, 'fixed');
            if (!snippet) return;
            if (at) inlineRef.current?.insertSnippetAt(snippet, at);
            else inlineRef.current?.insertSnippet(snippet);
            return;
        }
        const next = [...parts];
        if (index >= 0 && next[index]) next[index] = { type: 'data', path };
        else next.push({ type: 'data', path });
        emit(next);
    };
    const onPick = (path, opts = {}) => {
        const anchor = picker.pickerProps?.anchorEl || null;
        const pill = pillTarget.current;
        pillTarget.current = null;
        picker.closePicker();
        if (pill && inline) {
            const snippet = formatPathForInsert(path, 'fixed');
            if (snippet) inlineRef.current?.replacePill(pill, snippet);
            return;
        }
        proposePick(path, anchor, opts);
    };

    const onListChoice = (choice) => {
        const pick = listPick;
        setListPick(null);
        if (!pick || !choice) return;
        if (choice.mode === 'foreach' && onRequestForEach) {
            undoRef.current = { value, forEach: null };
            onRequestForEach(choice.forEach);
            onChange?.(choice.binding);
            const runs = pick.shape.rows ?? pick.shape.count;
            setForeachNote({ runs });
            return;
        }
        // first/last/join/count/each — a plain binding, emitted verbatim.
        onChange?.(choice.binding);
    };
    const undoForeach = () => {
        const undo = undoRef.current;
        undoRef.current = null;
        setForeachNote(null);
        if (!undo) return;
        onRequestForEach?.(null);
        onChange?.(undo.value ?? { kind: 'literal', value: '' });
    };

    const setText = (index, text) => {
        const next = [...parts];
        if (next[index]) next[index] = { type: 'text', text };
        else next.push({ type: 'text', text });
        emit(next);
    };
    const removeAt = (index) => emit(parts.filter((_, i) => i !== index));
    // What the text box emits, normalised through valueParts so a lone
    // pill is still a ref and plain words are still a literal — the same
    // shapes the chip editor writes.
    const emitInline = (text) => {
        const b = bindingFromInput(text, 'fixed');
        const p = parseValue(b);
        onChange?.(p.supported ? buildValue(p.parts, null, null) : b);
    };

    // Click-to-insert / drag-from-the-tree land as a new data part rather than
    // as text spliced at a caret — there is no raw text to splice into here.
    // The handle carries `opts` so an Alt-click in the Input tree bypasses the
    // list chooser ({ raw: true }).
    const broadcast = () => onFocusField?.({
        id: label || 'value',
        label: label || 'value',
        insert: (path, opts) => { pickTarget.current = -1; proposePick(path, null, opts); },
    });
    const onDrop = (e) => {
        const path = getBindingDropPath(e);
        if (!path) return;
        pickTarget.current = -1;
        proposePick(path, e.currentTarget, { raw: e.altKey, at: { x: e.clientX, y: e.clientY } });
    };

    const pickerNode = (
        <>
            <VariablePicker
                {...picker.pickerProps}
                groups={pickerCtx.groups}
                previewSample={sampleRoot}
                onPick={onPick}
                onClose={() => { pillTarget.current = null; picker.closePicker(); }}
                title={label
                    ? t('routines.builder.pick_data_for', 'Pick data for {field}', { field: label })
                    : t('routines.builder.pick_data', 'Pick data from a step')}
            />
            {resolver && (
                <MismatchResolver
                    path={resolver.path}
                    sampleRoot={sampleRoot}
                    stepLabelById={pickerCtx.stepLabelById}
                    actualKind={resolver.actualKind}
                    expectedKind={resolver.expectedKind}
                    selectedId={resolver.selectedId}
                    allowForEach={!!onRequestForEach}
                    onChoose={onResolverChoose}
                    onClose={() => setResolver(null)}
                />
            )}
            <ListPickChooser
                open={!!listPick}
                anchorEl={listPick?.anchorEl}
                path={listPick?.path}
                shape={listPick?.shape}
                sampleRoot={sampleRoot}
                stepLabelById={pickerCtx.stepLabelById}
                expectShape={expectShape}
                allowForEach={!!onRequestForEach}
                fieldLabel={label}
                onChoose={onListChoice}
                onCancel={() => setListPick(null)}
            />
        </>
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
            <div className="space-y-1">
                <BindingField
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
                    onRequestForEach={onRequestForEach}
                />
                <button
                    type="button"
                    onClick={() => setRawOpen(false)}
                    className={`text-[10px] ${INLINE_LINK}`}
                >
                    {t('routines.builder.back_to_simple', 'Back to the simple editor')}
                </button>
            </div>
        );
    }

    if (!parsed.supported) {
        return (
            <div className="space-y-1">
                {chrome}
                <div className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/50 px-2 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5">{t('routines.builder.custom_formula', 'Custom formula')}</div>
                    <FormulaChips text={parsed.text} stepLabelById={pickerCtx.stepLabelById} stepTypeById={pickerCtx.stepTypeById} />
                </div>
                {example != null && <ExampleLine value={example} />}
                <div className="flex items-center gap-3 text-[10px]">
                    <button type="button" onClick={() => setRawOpen(true)} className={INLINE_LINK}>
                        {t('routines.builder.edit_formula', 'Edit the formula')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onChange?.({ kind: 'literal', value: '' })}
                        className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        {t('routines.builder.replace_it', 'Replace it')}
                    </button>
                </div>
                {pickerNode}
            </div>
        );
    }

    const dataParts = parts.filter(p => p.type === 'data');
    const showTransform = parts.length === 1 && dataParts.length === 1;
    // A JSON pick is the whole value (see buildValue) — nothing to combine it
    // with, so the add buttons stand down rather than offering a dead end.
    const jsonOnly = parts.length === 1 && parts[0].type === 'json';
    // An empty value still renders ONE text box — as an element of the same
    // list, so typing the first character doesn't swap a single child for an
    // array and remount the input out from under the caret.
    const viewParts = parts.length ? parts : [{ type: 'text', text: '' }];

    return (
        <div className="space-y-1" onDragOver={onBindingDragOver} onDrop={onDrop}>
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
                        ? (showChrome ? label : t('routines.builder.value_of', '{field} value', { field: label }))
                        : t('routines.builder.value_word', 'Value')}
                    stepLabelById={pickerCtx.stepLabelById}
                    stepTypeById={pickerCtx.stepTypeById}
                    onPillClick={({ el, path }) => { pillTarget.current = el; pickTarget.current = -1; picker.openPicker(el, { focusPath: path }); }}
                    className={denseInputClass('w-full')}
                />
            ) : viewParts.map((part, i) => (part.type === 'text' ? (
                <TextPart
                    key={`t${i}`}
                    text={part.text}
                    placeholder={ph}
                    onChange={(t) => setText(i, t)}
                    onFocus={broadcast}
                    onRemove={viewParts.length > 1 ? () => removeAt(i) : null}
                />
            ) : (
                <DataPart
                    key={`d${i}`}
                    path={part.path}
                    jsonPath={part.type === 'json' ? part.jsonPath : null}
                    transform={showTransform ? parsed.transform : null}
                    transformArg={showTransform ? parsed.transformArg : null}
                    stepLabelById={pickerCtx.stepLabelById}
                    stepTypeById={pickerCtx.stepTypeById}
                    onChange={part.type === 'json' ? null : (e) => openPicker(e.currentTarget, i, part.path)}
                    onRemove={() => removeAt(i)}
                />
            )))}

            <div className="flex items-center gap-3 flex-wrap">
                {!jsonOnly && (
                    <button
                        type="button"
                        onClick={(e) => openPicker(e.currentTarget, -1)}
                        className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline"
                    >
                        {/* The first pick is the headline action; once something
                            is bound, picking again APPENDS — so it reads as an add. */}
                        <Workflow size={11} /> {dataParts.length
                            ? t('routines.builder.add_data', 'Add data')
                            : t('routines.builder.use_data_from_step', 'Use data from a step')}
                    </button>
                )}
                {!inline && dataParts.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setComposing(true)}
                        className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <Plus size={11} /> {t('routines.builder.add_text', 'Add text')}
                    </button>
                )}
                {allowRaw && (
                    <button
                        type="button"
                        onClick={() => setRawOpen(true)}
                        title={t('routines.builder.write_as_formula', 'Write this value as a formula')}
                        aria-label={t('routines.builder.write_as_formula', 'Write this value as a formula')}
                        className="ml-auto flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        {/* The visible word, not just the tooltip: this button
                            had its title and aria-label translated while the
                            label itself stayed English, so a Dutch workspace
                            read a Dutch tooltip over an English button.
                            `mode_formula_word` is the same word BindingField's
                            mode toggle already uses (conventions §1.3.1: the
                            key exists, so use it). */}
                        <FunctionSquare size={11} /> {t('routines.builder.mode_formula_word', 'Formula')}
                    </button>
                )}
            </div>

            {showTransform && (() => {
                // A list-resolving pick reads "Use it as:" and sorts the
                // choices for the KIND the pick actually has first — a number
                // leads with "as an amount", a table with "as a table"
                // (artboard 2c). `for` orders and annotates, it NEVER removes
                // an entry (sample data is often missing or wrong).
                const pickedShape = pathListShape(dataParts[0]?.path, sampleRoot);
                const pickedKind = kindAtPath(dataParts[0]?.path, sampleRoot);
                const rank = (tr) => (tr.for === pickedKind ? 0 : tr.for === 'any' ? 1 : 2);
                const ordered = pickedKind === 'unknown'
                    ? VALUE_TRANSFORMS
                    : [...VALUE_TRANSFORMS].sort((a, b) => rank(a) - rank(b));
                return (
                    <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)] flex-wrap">
                        {pickedShape
                            ? t('routines.builder.use_it_as', 'Use it as:')
                            : t('routines.builder.adjust_it', 'Adjust it:')}
                        <select
                            aria-label={t('routines.builder.adjust_aria', 'Adjust the value')}
                            value={parsed.transform || ''}
                            onChange={(e) => {
                                // A fresh transform starts from ITS OWN default
                                // argument, never from the previous one — a
                                // separator is not a date notation.
                                const next = e.target.value || null;
                                const spec = next ? TRANSFORM_BY_ID[next] : null;
                                emit(parts, next, spec?.argDefault ?? null, spec?.arg2Default ?? null);
                            }}
                            className={controlSurfaceClass('px-1.5 py-0.5 text-[11px]')}
                        >
                            <option value="">{t('routines.builder.use_as_is', 'use it as it is')}</option>
                            {ordered.map(tr => (
                                <option key={tr.id} value={tr.id} title={tr.hint}>{tr.label}</option>
                            ))}
                        </select>
                        <TransformArg
                            transform={parsed.transform}
                            arg={parsed.transformArg}
                            arg2={parsed.transformArg2}
                            onChange={(a, b) => emit(parts, parsed.transform, a, b)}
                        />
                        {pickedShape && !parsed.transform && (
                            <span className={listBadgeClass()} title={pickedShape.explainEn}>
                                {pickedShape.count != null ? `${t('routines.builder.list_word', 'list')} · ${pickedShape.count}` : t('routines.builder.list_word', 'list')}
                            </span>
                        )}
                    </label>
                );
            })()}

            {foreachNote && (
                <div className={`${AMBER_NOTE} flex items-center gap-2`}>
                    {t('routines.builder.foreach_set_note', 'This step now runs once per row — {n} runs.', { n: foreachNote.runs ?? '?' })}
                    <button type="button" onClick={undoForeach} className="underline hover:no-underline">
                        {t('routines.builder.undo', 'Undo')}
                    </button>
                </div>
            )}

            {emptyNote}
            {example != null && <ExampleLine value={example} />}
            {pickerNode}
        </div>
    );
}

// The separators the inline join editor offers — same wording as the chooser.
const JOIN_SEPARATORS = [
    { value: ', ', label: 'a comma and a space' },
    { value: ',', label: 'a comma' },
    { value: '; ', label: 'a semicolon' },
    { value: ' ', label: 'a space' },
    { value: '\n', label: 'a new line' },
];

/**
 * The second half of a transform that carries one: join's separator,
 * formatNumber's style, formatDate's notation, yesNoText's two words
 * (artboard 2c, "In tekst: kies …"). Renders nothing for the transforms that
 * take no argument, so the row stays one line for the common case.
 */
function TransformArg({ transform, arg, arg2, onChange }) {
    const { t } = useTranslation();
    if (transform === 'join') {
        const current = arg ?? ', ';
        const known = JOIN_SEPARATORS.some(s => s.value === current);
        return (
            <span className="flex items-center gap-1">
                {t('routines.builder.separated_by', 'Separated by')}
                <select
                    aria-label={t('routines.builder.separated_by', 'Separated by')}
                    value={known ? current : '__other__'}
                    onChange={(e) => { if (e.target.value !== '__other__') onChange(e.target.value, null); }}
                    className={controlSurfaceClass('px-1.5 py-0.5 text-[11px]')}
                >
                    {JOIN_SEPARATORS.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
                    {!known && <option value="__other__">{JSON.stringify(arg)}</option>}
                </select>
            </span>
        );
    }
    if (transform === 'formatNumber' || transform === 'formatDate') {
        const isDate = transform === 'formatDate';
        const options = isDate ? DATE_FORMATS : NUMBER_STYLES;
        const current = arg ?? options[0].value;
        const known = options.some(o => o.value === current);
        const label = isDate
            ? t('routines.builder.date_notation', 'Written as')
            : t('routines.builder.number_style', 'Shown as');
        return (
            <span className="flex items-center gap-1">
                {label}
                <select
                    aria-label={label}
                    value={known ? current : '__other__'}
                    onChange={(e) => { if (e.target.value !== '__other__') onChange(e.target.value, null); }}
                    className={controlSurfaceClass('px-1.5 py-0.5 text-[11px]')}
                >
                    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    {/* A hand-written notation stays selectable rather than
                        being silently replaced by the first preset. */}
                    {!known && <option value="__other__">{current}</option>}
                </select>
            </span>
        );
    }
    if (transform === 'yesNoText') {
        return (
            <span className="flex items-center gap-1">
                {t('routines.builder.yes_says', 'Yes says')}
                <input
                    type="text"
                    value={arg ?? 'yes'}
                    aria-label={t('routines.builder.yes_says', 'Yes says')}
                    onChange={(e) => onChange(e.target.value, arg2 ?? 'no')}
                    className={denseInputClass('w-20')}
                />
                {t('routines.builder.no_says', 'no says')}
                <input
                    type="text"
                    value={arg2 ?? 'no'}
                    aria-label={t('routines.builder.no_says', 'no says')}
                    onChange={(e) => onChange(arg ?? 'yes', e.target.value)}
                    className={denseInputClass('w-20')}
                />
            </span>
        );
    }
    return null;
}

function ExampleLine({ value }) {
    const { t } = useTranslation();
    return (
        <div className="text-[10px] text-[var(--text-tertiary)] flex items-center gap-1.5 min-w-0">
            <Eye size={11} className="shrink-0" />
            <span className="shrink-0">{t('routines.builder.how_it_looks', "Here's how it looks:")}</span>
            <span className="text-[var(--text-secondary)] truncate">{value}</span>
        </div>
    );
}

function TextPart({ text, placeholder, onChange, onFocus, onRemove = null }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1">
            <input
                type="text"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                onFocus={onFocus}
                placeholder={placeholder}
                className={denseInputClass('flex-1 min-w-0')}
            />
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('routines.builder.remove_text', 'Remove this text')}
                    className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-secondary)]"
                >
                    <X size={12} />
                </button>
            )}
        </div>
    );
}

const SOURCE_ICON = { steps: Workflow, trigger: Zap, loop: Repeat, item: List, vars: Tag };

// What a transformed chip says after its name — the chip itself is the only
// place the eye lands, so the transform must be visible ON it, not only in
// the dropdown below.
const TRANSFORM_SUFFIX = {
    join: '· joined',
    first: '· first of the list',
    last: '· last of the list',
    count: '· how many',
    // 2b draws these ON the chip: "· als € 1.500.000", "· als tabel".
    formatDate: '· as a written date',
    yesNoText: '· in your own words',
    groupSummary: '· as a summary',
    asTable: '· as a table',
};

/** formatNumber says WHICH format on the chip — the three read very differently. */
const NUMBER_STYLE_SUFFIX = {
    amount: '· as an amount',
    currency: '· as an amount',
    percent: '· as a percentage',
    plain: '· as a plain number',
};

function DataPart({ path, stepLabelById, stepTypeById = null, onChange, onRemove, jsonPath = null, transform = null, transformArg = null }) {
    const { t } = useTranslation();
    const { name, suffix, missing, source } = describeDataPath(path, stepLabelById);
    const Icon = SOURCE_ICON[source] || Workflow;
    const stepId = /^steps\.([^.[]+)/.exec(String(path || ''))?.[1] || null;
    const tint = pillTint({ source: source === 'item' ? 'loop' : source, stepId }, stepTypeById);
    return (
        <div className="flex items-center gap-1">
            <span
                title={jsonPath ? `parseJson(${path}, "${jsonPath}")` : path}
                onClick={onChange || undefined}
                role={onChange ? 'button' : undefined}
                style={{ '--pill-tint': tint }}
                className={`inline-flex items-center gap-1 min-w-0 rounded px-2 py-1 text-[11px] border ${
                    missing
                        ? 'border-dashed border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
                        : PILL_TINT_CLASS
                }`}
            >
                <Icon size={11} className="shrink-0 opacity-70" />
                <span className="font-medium truncate">{name}</span>
                {suffix && <span className="opacity-70 truncate">▸ {suffix}</span>}
                {(transform === 'formatNumber'
                    ? NUMBER_STYLE_SUFFIX[transformArg || 'plain']
                    : TRANSFORM_SUFFIX[transform]) && (
                    <span className="opacity-70 truncate">
                        {transform === 'formatNumber'
                            ? NUMBER_STYLE_SUFFIX[transformArg || 'plain']
                            : TRANSFORM_SUFFIX[transform]}
                    </span>
                )}
                {jsonPath != null && (
                    <span className="opacity-70 truncate">
                        {t('routines.builder.from_the_json', '· from the JSON')}{jsonPath ? `: ${jsonPath}` : ''}
                    </span>
                )}
            </span>
            {onChange && (
                <button
                    type="button"
                    onClick={onChange}
                    className="shrink-0 text-[10px] text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]"
                >
                    {t('routines.builder.change_word', 'change')}
                </button>
            )}
            <button
                type="button"
                onClick={onRemove}
                aria-label={t('routines.builder.remove_value', 'Remove this value')}
                className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-secondary)]"
            >
                <X size={12} />
            </button>
        </div>
    );
}

/**
 * Read-only render of a formula with its step references resolved to names.
 * Deliberately NOT RefChips: that component only knows the `steps.`/`trigger.`/
 * `loop.` roots, so a list-mode `item.subject` would come out raw. Here every
 * pickable path goes through describeDataPath.
 */
const FORMULA_PATH = /(?<![A-Za-z0-9_$."'])(?:steps|trigger|loop|vars|item|_index)(?:\.[A-Za-z0-9_$]+|\[[^\]]*\])*/g;

function FormulaChips({ text, stepLabelById, stepTypeById = null }) {
    const source = String(text || '');
    const nodes = [];
    let last = 0;
    let m;
    FORMULA_PATH.lastIndex = 0;
    while ((m = FORMULA_PATH.exec(source))) {
        if (m.index > last) nodes.push({ text: source.slice(last, m.index) });
        nodes.push({ path: m[0] });
        last = m.index + m[0].length;
    }
    if (last < source.length) nodes.push({ text: source.slice(last) });

    return (
        <div className="text-[11px] leading-[1.6] break-words text-[var(--text-primary)]">
            {nodes.map((n, i) => {
                if (n.text != null) return <span key={i} className="font-mono opacity-70">{n.text}</span>;
                const { name, suffix, source: refSource } = describeDataPath(n.path, stepLabelById);
                // The SOURCE STEP's family colour, exactly like every other
                // reference pill (DataPart above, RefTokenInput). `--accent`
                // used to tint these: a grey that reads as "disabled" and, on
                // the canvas, is banned outright (nodeTypeColors.js).
                const stepId = /^steps\.([^.[]+)/.exec(String(n.path || ''))?.[1] || null;
                const tint = pillTint({ source: refSource === 'item' ? 'loop' : refSource, stepId }, stepTypeById);
                return (
                    <span
                        key={i}
                        title={n.path}
                        style={{ '--pill-tint': tint }}
                        className={`inline-flex items-center gap-1 align-middle mx-0.5 rounded px-1.5 py-0.5 border ${PILL_TINT_CLASS}`}
                    >
                        <span className="font-medium">{name}</span>
                        {suffix && <span className="opacity-70">▸ {suffix}</span>}
                    </span>
                );
            })}
        </div>
    );
}

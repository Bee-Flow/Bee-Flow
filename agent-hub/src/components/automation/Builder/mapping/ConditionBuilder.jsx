import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ConditionBuilderRow from './ConditionBuilderRow';
import CustomRuleCard from './CustomRuleCard';
import { ExpressionHelpBody } from './ExpressionHelp';
import InsertDataButton from './InsertDataButton';
import TopicNotice from './TopicNotice';
import useVariablePicker from './useVariablePicker';
import VariablePicker from './VariablePicker';
import { useVariablePickerContext } from './VariablePickerContext';
import useTranslation from '../../../../hooks/useTranslation';
import { insertAtCursor, formatPathForInsert } from '../../../../utils/bindingHelpers';
import { useFormMode } from '../flow/settings/formDensity';
import { denseInputClass, INLINE_LINK } from '../flow/settings/formStyles';
import { serializeRows, parseExprToRows, emptyRow } from '../utils/conditionModel';

/**
 * Clickable, datatype-aware condition editor — shared by the condition,
 * filter and switch step editors.
 *
 * Visual mode (default): one or more rows of [field] [operator] [value],
 * joined by AND / OR. The field is picked with a BindingField (variable
 * picker), the operator list adapts to the field's inferred datatype, and
 * the whole thing serialises to the restricted-JS `expr` string the server
 * evaluates (comparators + the whitelisted `contains/startsWith/…` helpers).
 *
 * Advanced raw mode: a plain textarea. Anything the model can't represent
 * (mixed AND/OR, unusual grammar) keeps the user in raw mode without losing
 * their expression. Simple mode never shows a formula: such a rule reads as a
 * Custom rule card naming the fields it reads (CustomRuleCard), with a way to
 * build it again by clicking. Each row renders in ConditionBuilderRow.
 *
 * Props:
 *   value         — current raw expression string (the step's `expr`)
 *   onChange      — (next: string) => void
 *   onFocusField  — focus broadcaster forwarded to nested BindingFields
 *   previewSample — merged sample tree, used to infer field datatypes
 *   context       — 'condition' | 'filter' | 'switch' (tunes hints only)
 *
 * Two OPTIONAL props keep the technical surface out of the Condition node's form
 * without changing this component for its other caller (App Studio's
 * ConditionField), which passes neither:
 *   fieldOptions   — [{path,label,sample,group}]: render the left-hand side as
 *                    a FieldPicker (names, not paths). `fieldBase` is the root
 *                    a free-typed name resolves against.
 *   showSerialized — false hides the generated-expression line beneath the
 *                    rows (the Filter form shows it under Advanced instead).
 *   topics         — `{ available, reason }` from the builder catalog: offers
 *                    "is about" (the topic classifier). Only the Condition
 *                    node passes it; App Studio formulas cannot ask one.
 */
// A bare `true`/`false` is what a freshly-created condition/filter step
// defaults to (see DiagramPane.jsx's buildStepFromPayload) — "not configured
// yet", not a real condition. Treat it like an empty value (open the visual
// builder with a blank row) instead of dropping to the raw textarea; leaving
// the row empty and saving still correctly surfaces the usual
// condition.expr_missing/filter.expr_missing validation error.
function isTrivialValue(v) {
    return /^(true|false)$/.test(String(v ?? '').trim());
}

export default function ConditionBuilder({
    value = '', onChange, onFocusField, previewSample = null, context = 'condition',
    fieldOptions = null, fieldBase = 'item', showSerialized = true,
    // Example paths for the two free-text boxes. App Studio has no 
    // root, so the automations-shaped defaults below sent a Studio author off
    // writing an expression that could never resolve.
    placeholders = null,
    topics,
}) {
    // Simple mode never shows a formula: no raw box, no "Write raw expression",
    // no "Use an expression instead". A rule the rows cannot show is a card.
    const simple = useFormMode() === 'simple';
    const [swapRef, armFocus] = useFocusAfterSwap();
    const state = useConditionRows(value, onChange, armFocus, simple);

    if (state.rawMode && simple) {
        return <div ref={swapRef}><CustomRuleCard expr={value} onRebuild={state.rebuild} /></div>;
    }
    if (state.rawMode) {
        return (
            <div ref={swapRef}><RawExpression
                value={value}
                context={context}
                placeholders={placeholders}
                onChange={state.emitRaw}
                onFocusField={onFocusField}
                canUseVisual={!value || !!parseExprToRows(value)}
                onUseVisual={state.toVisual}
            /></div>
        );
    }
    const rowProps = { previewSample, fieldOptions, fieldBase, simple, context, topics, placeholders, onFocusField };
    return (
        <div className="space-y-2">
            {state.rows.length > 1 && <JoinToggle join={state.join} onChange={state.changeJoin} />}
            <div className="space-y-1.5" ref={swapRef}>
                {state.rows.map((row, i) => (
                    <ConditionBuilderRow
                        key={i}
                        {...rowProps}
                        row={row}
                        rawField={state.rawFieldRows.has(i)}
                        canRemove={state.rows.length > 1}
                        onReplace={(next) => state.replaceRow(i, next)}
                        onRemove={() => state.removeRow(i)}
                        onUseExpression={() => state.markRawField(i)}
                    />
                ))}
            </div>
            <TopicNotice topics={topics} ops={state.rows.map((r) => r.op)} />
            {state.rebuilding && <RebuildNote onKeep={state.keepFormula} />}
            <RowsFooter simple={simple} onAdd={state.addRow} onRaw={() => state.setRawMode(true)} serialized={showSerialized ? value : ''} />
        </div>
    );
}

/** Rows and join for `value`, `{ rows, join }` → expr on every edit, and the raw/rebuild modes. */
function useConditionRows(value, onChange, armFocus, simple = false) {
    // Parse once for the initial state; subsequent external changes are
    // reconciled in the effect below.
    const [initial] = useState(() => (isTrivialValue(value) ? null : parseExprToRows(value)));
    const [rows, setRows] = useState(() => (initial?.rows?.length ? initial.rows : [emptyRow()]));
    const [join, setJoin] = useState(() => initial?.join || '&&');
    const [rawMode, setRawMode] = useState(() => !!value && !isTrivialValue(value) && !initial);
    // Simple mode, "Build it again by clicking": one empty row while the saved
    // formula stays in place until a field is picked.
    const [rebuilding, setRebuilding] = useState(false);
    // Rows the user opted OUT of the friendly field picker for (the "use an
    // expression instead" escape). Per-row, so one computed left-hand side
    // doesn't drag the rest of the form back to raw paths.
    const [rawFieldRows, setRawFieldRows] = useState(() => new Set());
    const lastEmit = useRef(value);

    const showRows = (parsed) => {
        setRows(parsed?.rows?.length ? parsed.rows : [emptyRow()]);
        setJoin(parsed?.join || '&&');
        setRawMode(false);
    };
    // Re-hydrate when `value` changes from OUTSIDE this component (switching
    // steps, an AI edit, a restore). We skip our own emits via `lastEmit`.
    useEffect(() => {
        if (value === lastEmit.current) return;
        const trivial = isTrivialValue(value);
        const parsed = trivial ? null : parseExprToRows(value);
        if (value && !trivial && !parsed) setRawMode(true);
        else showRows(parsed);
        setRebuilding(false);
        lastEmit.current = value;
    }, [value]);

    // R8/R12: the formula box of Advanced is not a reason for a Custom rule
    // card. Back in Simple, a formula the rows can show opens as rows (with the
    // field_missing hint where it applies), exactly as when the step reopens.
    // Adjusted while rendering, on the switch itself (React's pattern for
    // state that follows a prop), not in an effect.
    const [wasSimple, setWasSimple] = useState(simple);
    if (wasSimple !== simple) {
        setWasSimple(simple);
        const parsed = simple && rawMode && !isTrivialValue(value) ? parseExprToRows(value) : null;
        if (simple && rawMode && (isTrivialValue(value) || parsed)) showRows(parsed);
    }

    const emitRaw = (expr) => { lastEmit.current = expr; onChange?.(expr); };
    const commit = (nextRows, nextJoin) => {
        setRows(nextRows);
        setJoin(nextJoin);
        // While rebuilding, the formula is only replaced once a field is picked.
        if (rebuilding && !nextRows.some(hasField)) return;
        setRebuilding(false);
        emitRaw(serializeRows(nextRows, nextJoin));
    };
    return {
        rows, join, rawMode, rebuilding, rawFieldRows, setRawMode, emitRaw,
        replaceRow: (i, nextRow) => commit(rows.map((r, k) => (k === i ? nextRow : r)), join),
        addRow: () => commit([...rows, emptyRow()], join),
        removeRow: (i) => {
            const next = rows.filter((_, k) => k !== i);
            commit(next.length ? next : [emptyRow()], join);
        },
        changeJoin: (j) => commit(rows, j),
        markRawField: (i) => setRawFieldRows((set) => new Set(set).add(i)),
        toVisual: () => showRows(parseExprToRows(value)),
        // Both buttons remove themselves with the view they sit in (armFocus).
        rebuild: () => { armFocus?.(); setRawFieldRows(new Set()); setRebuilding(true); showRows(null); },
        keepFormula: () => { armFocus?.(); setRebuilding(false); setRawMode(true); },
    };
}

const FOCUSABLE = 'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * After "Build it again by clicking" or "Keep the formula" (the button is gone
 * with the view it sat in): focus the first control of what replaced it, the
 * first row's field, the card's rebuild button, or the formula box. Only
 * after those clicks, never when a step opens or its value changes outside.
 */
function useFocusAfterSwap() {
    const ref = useRef(null);
    const armed = useRef(false);
    useEffect(() => {
        if (!armed.current) return;
        armed.current = false;
        ref.current?.querySelector(FOCUSABLE)?.focus();
    });
    const arm = useCallback(() => { armed.current = true; }, []);
    return [ref, arm];
}

/** "Add condition", and in Advanced the way into the formula box and the written expression. */
function RowsFooter({ simple, onAdd, onRaw, serialized }) {
    return (
        <>
            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={onAdd}
                    className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
                >
                    <Plus size={12} /> Add condition
                </button>
                {!simple && (
                    <button type="button" onClick={onRaw} className="text-[10px] text-[var(--accent)] hover:underline shrink-0">
                        Write raw expression
                    </button>
                )}
            </div>
            {!simple && serialized && (
                <div className="text-[10px] text-[var(--text-tertiary)] font-mono truncate" title={serialized}>{serialized}</div>
            )}
        </>
    );
}

/** While rebuilding a formula by clicking: it stays until a field is picked, or comes back. */
function RebuildNote({ onKeep }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-tertiary)]">
            <span>{t('condition_node.custom.rebuild_note', 'The formula stays until you pick a field.')}</span>
            <button type="button" onClick={onKeep} className={`shrink-0 ${INLINE_LINK}`}>
                {t('condition_node.custom.keep', 'Keep the formula')}
            </button>
        </div>
    );
}

const hasField = (r) => !!String((r.field?.kind === 'ref' ? r.field.path : r.field?.value) || '').trim();

/** "Match [all|any] of these conditions:" above two or more rows. */
function JoinToggle({ join, onChange }) {
    return (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <span>Match</span>
            <div className="inline-flex rounded border border-[var(--border-default)] overflow-hidden">
                {[['&&', 'all'], ['||', 'any']].map(([j, lbl]) => (
                    <button
                        key={j}
                        type="button"
                        onClick={() => onChange(j)}
                        className={`px-2 py-0.5 text-[11px] ${join === j ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        {lbl}
                    </button>
                ))}
            </div>
            <span>of these conditions:</span>
        </div>
    );
}

/**
 * Raw-expression mode: the plain textarea plus (new) a caret-aware {}
 * variable insert and a collapsible syntax-help panel driven by the FE
 * mirror of the server whitelist (exprFunctions.js). Saved raw exprs open
 * here exactly as before — textarea + "Use visual builder" escape are
 * unchanged.
 */
function RawExpression({ value, context, onChange, onFocusField, canUseVisual, onUseVisual, placeholders = null }) {
    const [showHelp, setShowHelp] = useState(false);
    const taRef = useRef(null);
    const picker = useVariablePicker();
    const pickerCtx = useVariablePickerContext();

    // A pick goes in as its own operand, in the canonical spelling the engine
    // reads (`headers["content-type"]`, not a subtraction). Spliced straight
    // against a name or a closing bracket it would fuse into one bogus path.
    const insertAt = (path) => {
        const el = taRef.current;
        const snippet = formatPathForInsert(path, 'expression');
        if (!el || !snippet) return;
        const before = el.value.slice(0, el.selectionStart ?? el.value.length);
        const after = el.value.slice(el.selectionEnd ?? el.value.length);
        const pre = /[A-Za-z0-9_$\])"']$/.test(before) ? ' ' : '';
        const post = /^[A-Za-z0-9_$(["']/.test(after) ? ' ' : '';
        const result = insertAtCursor(el, `${pre}${snippet}${post}`);
        if (result != null) onChange(result);
    };

    return (
        <div className="space-y-1">
            <div className="group flex items-stretch gap-1">
                <textarea
                    ref={taRef}
                    rows={3}
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholders?.raw || (context === 'filter' ? 'item.amount > 1000' : 'steps.step1.output.amount > 1000')}
                    onFocus={() => onFocusField?.({
                        id: 'expression',
                        label: 'condition expression',
                        insert: insertAt,
                    })}
                    className={denseInputClass('w-full font-mono')}
                />
                <InsertDataButton
                    onClick={(e) => picker.openPicker(e.currentTarget)}
                    open={picker.open}
                />
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
                <button
                    type="button"
                    onClick={() => setShowHelp(h => !h)}
                    className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                >
                    {showHelp ? <ChevronDown size={11} /> : <ChevronRight size={11} />} What can I write here?
                </button>
                {canUseVisual && (
                    <button
                        type="button"
                        onClick={onUseVisual}
                        className="text-[10px] text-[var(--accent)] hover:underline"
                    >
                        Use visual builder
                    </button>
                )}
            </div>
            {showHelp && <ExpressionHelpBody />}
            <VariablePicker
                {...picker.pickerProps}
                groups={pickerCtx.groups}
                previewSample={pickerCtx.previewSample}
                onPick={(path) => { insertAt(path); picker.closePicker(); }}
                title="Insert variable"
            />
        </div>
    );
}

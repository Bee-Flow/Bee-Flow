import { compile as compileExpr } from '@shared/expr/engine.mjs';
import { legacyPathOf, sourceFromPath } from '@shared/mapping/index.mjs';
import type { Slot } from '@shared/mapping/index.mjs';
import { ChevronDown, ChevronRight, FunctionSquare, Sparkles, Type } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent, type ReactNode } from 'react';
import { getBindingDropPath, onBindingDragOver } from './bindingDnd';
import { isLoneRef, pickedBinding, sameBinding, translateForMode, type Mode } from './bindingFieldModel';
import BindingFieldPreview from './BindingFieldPreview';
import { ExpressionHelpBody as ExpressionHelpBodyJs } from './ExpressionHelp';
import { EmptySlotNote as EmptySlotNoteJs, FieldLabelRow as FieldLabelRowJs } from './fieldChrome';
import InsertDataButtonJs from './InsertDataButton';
import RefTokenInputJs from './RefTokenInput';
import useVariablePickerJs from './useVariablePicker';
import VariablePickerJs from './VariablePicker';
import { useVariablePickerContext as usePickerContextJs } from './VariablePickerContext';
import { useAssistantField as useAssistantFieldJs } from '../chat/AssistantFieldContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import {
    bindingFromInput as bindingFromInputJs, formatPathForInsert as formatPathJs,
    getAutocompleteTokenFromPrefix as autocompleteTokenJs, inputFromBinding as inputFromBindingJs,
} from '../../../../utils/bindingHelpers';
import { useFormMode as useFormModeJs } from '../flow/settings/formDensity';
import { denseInputClass as denseInputClassJs, FOCUS_RING_INSET } from '../flow/settings/formStyles';
import { readableFieldName, useFieldHandle, type FieldHandle, type InsertOpts } from '../valueSlot/fieldHandle';
import { slotFor } from '../valueSlot/slotModel';

// The surrounding modules are untyped JS; their props and returns are checked there.
type AnyComponent = ComponentType<Record<string, unknown>>;
const ExpressionHelpBody = ExpressionHelpBodyJs as unknown as AnyComponent;
const EmptySlotNote = EmptySlotNoteJs as unknown as AnyComponent;
const FieldLabelRow = FieldLabelRowJs as unknown as AnyComponent;
const InsertDataButton = InsertDataButtonJs as unknown as AnyComponent;
const RefTokenInput = RefTokenInputJs as unknown as ComponentType<Record<string, unknown> & { ref?: unknown }>;
const VariablePicker = VariablePickerJs as unknown as AnyComponent;
const bindingFromInput = bindingFromInputJs as (text: unknown, mode: Mode) => Record<string, unknown> & { kind: string; path?: string };
const inputFromBinding = inputFromBindingJs as (b: unknown) => { mode: Mode; text: string };
const formatPathForInsert = formatPathJs as (path: string, mode: Mode) => string;
const autocompleteToken = autocompleteTokenJs as (before: string, mode: Mode) => { length: number; query: string } | null;
const denseInputClass = denseInputClassJs as (extra?: string) => string;
const useFormMode = useFormModeJs as () => string;
const useAssistantField = useAssistantFieldJs as () => ((args: Record<string, unknown>) => void) | null;
const usePickerContext = usePickerContextJs as () => {
    groups: unknown[]; previewSample: object | null; stepLabelById: Map<string, string> | null; stepTypeById: Map<string, string> | null;
};
interface Picker {
    open: boolean;
    openPicker: (el: Element | null | undefined, opts?: Record<string, unknown>) => void;
    closePicker: () => void;
    pickerProps: Record<string, unknown>;
}
const useVariablePicker = useVariablePickerJs as () => Picker;

interface Editor {
    element: HTMLElement | null;
    focus: () => void;
    insertSnippet: (s: string) => void;
    insertSnippetAt: (s: string, at: { x: number; y: number }) => void;
    replacePartial: (n: number, s: string) => void;
    replacePill: (el: Element, s: string) => void;
    textBeforeCaret: () => string;
}

export interface BindingFieldProps {
    value: unknown;
    onChange?: (binding: unknown) => void;
    label?: string | null;
    hint?: ReactNode;
    required?: boolean;
    placeholder?: string;
    onFocusField?: ((handle: FieldHandle) => void) | null;
    previewSample?: object | null;
    multiline?: boolean;
    autoMapped?: boolean;
    /** The syntax legend under the field in Formula mode (ConditionBuilder's row slots turn it off). */
    showExpressionHelp?: boolean;
    /** 'list' | 'scalar' | 'unknown': what the parameter's schema wants (amber note for a list in a 'scalar'). */
    expectShape?: string | null;
    /** The word for what the slot wants (fieldKinds expectedKindFor): the chrome and the slot below. */
    expectKind?: string | null;
    /** What the field wants, exactly (core Slot). Derived from expectKind/expectShape when absent. */
    slot?: Partial<Slot> | null;
    /** Hide the label row (a host that draws its own). */
    hideLabel?: boolean;
    /**
     * Formula mode only, no Text / Formula switch: a field that holds a path
     * string (SlotAdvanced's path storage), where a Text-mode `{{ }}` would be
     * stored as a path the runtime cannot walk.
     */
    formulaOnly?: boolean;
}

/**
 * The formula editor: one input and a Text / Formula switch. The binding
 * kind (literal/ref/template/expr) is inferred from what is typed:
 *
 *   Text:     plain text → literal; text with "{{…}}" → template
 *   Formula:  one path (escaped keys included) → ref; anything else → expr
 *
 * References show as pills (RefTokenInput). A value picked into the field
 * (a click in "Comes in", a drop, the {} picker, a clicked pill, the
 * autocomplete) goes through ONE function, `acceptPath`:
 *   - into an empty field, onto the only reference of a formula, or onto a
 *     re-picked pill that is the field's only reference, it is the whole
 *     value, and a list gets what the field wants of it
 *     (bindingFieldModel.pickedBinding: `join(p, "\n")`, `first(p)`, …);
 *   - otherwise it is inserted at the caret (in Text, `{{a}}` then `{{b}}`
 *     is a template), and in Formula mode never glued onto the text before it.
 * A reference that resolves to a list in a single-value field gets an amber
 * note with "Choose how to use the list", worked out from the CURRENT value
 * on every render (BindingFieldPreview), so it can never describe a value the
 * field no longer holds.
 *
 * Focus hands the drawer a handle (onFocusField) whose methods always run
 * this field's latest state (valueSlot/fieldHandle.ts).
 */
export default function BindingField({
    value, onChange, label = null, hint = null, required = false, placeholder = '', onFocusField = null,
    previewSample = null, multiline = false, autoMapped = false, showExpressionHelp = true,
    expectShape = null, expectKind = null, slot = null, hideLabel = false, formulaOnly = false,
}: BindingFieldProps) {
    const seed = inputFromBinding(value);
    const [modeState, setMode] = useState<Mode>(seed.mode);
    const mode: Mode = formulaOnly ? 'expression' : modeState;
    const [text, setText] = useState(seed.text);
    const [focused, setFocused] = useState(false);
    // The blur is deferred so a click in "Comes in" still finds the field;
    // cancelled on refocus and on unmount, so it never fires on a torn-down tree.
    const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);
    const [helpOpen, setHelpOpen] = useState(false);
    const inputRef = useRef<Editor | null>(null);
    const { t } = useTranslation();
    const formMode = useFormMode();
    const askAssistant = useAssistantField();
    const picker = useVariablePicker();
    const pickerCtx = usePickerContext();
    const sample = previewSample ?? pickerCtx.previewSample;
    const fieldSlot = useMemo(
        () => slotFor({ slot, expectKind: expectKind || (expectShape === 'scalar' ? 'text' : expectShape === 'list' ? 'list' : null) }),
        [slot, expectKind, expectShape],
    );

    // The last binding WE emitted: the parent echoes it back as a fresh
    // object, and an empty formula round-trips as a literal '' that would
    // otherwise kick the field back to Text (BFSF-321).
    const lastEmittedRef = useRef<unknown>(null);
    useEffect(() => {
        if (lastEmittedRef.current !== null && sameBinding(value, lastEmittedRef.current)) return;
        lastEmittedRef.current = null;
        const s = inputFromBinding(value);
        setMode(s.mode);
        setText(s.text);
    }, [value]);

    const emit = (nextText: string, nextMode: Mode) => {
        setText(nextText);
        const next = bindingFromInput(nextText, nextMode);
        lastEmittedRef.current = next;
        onChange?.(next);
    };
    // Adopt a whole binding (a picked value, an answer from the list options).
    const applyBinding = (b: unknown) => {
        const s = inputFromBinding(b);
        setMode(s.mode);
        setText(s.text);
        lastEmittedRef.current = b;
        onChange?.(b);
    };

    // The autocomplete: how many typed characters an accepted suggestion swallows.
    const autocompleteLength = useRef(0);
    // The pill a click is re-picking.
    const pillTarget = useRef<Element | null>(null);

    const acceptPath = (path: string, opts: InsertOpts & { pill?: Element | null; swallow?: number } = {}) => {
        const clean = String(path || '').trim();
        const snippet = formatPathForInsert(clean, mode);
        const editor = inputRef.current;
        if (!snippet) return;
        const typed = String(text || '').trim();
        // A lone reference is replaced, not added to, where adding would be
        // wrong: in a formula (two paths are no formula), and when its own
        // pill is re-picked. In Text two `{{ }}` side by side are a template.
        const lone = (mode === 'expression' || !!opts.pill) && isLoneRef(text, mode);
        const whole = !opts.raw && (!typed || lone || (!!opts.swallow && typed.length <= opts.swallow));
        if (whole) {
            applyBinding(pickedBinding(clean, { mode, slot: fieldSlot, sample, source: opts.source, shapeHint: opts.shape }));
            return;
        }
        if (!editor) return;
        if (opts.pill) { editor.replacePill(opts.pill, snippet); return; }
        if (opts.swallow) { editor.replacePartial(opts.swallow, snippet); return; }
        // A formula never gets two paths glued into one.
        const spaced = mode === 'expression' && typed ? ` ${snippet}` : snippet;
        if (opts.at) editor.insertSnippetAt(spaced, opts.at);
        else editor.insertSnippet(spaced);
    };

    // Its name in the drawer's "→ …": the label, else an example that holds no path.
    const handle = useFieldHandle(label || placeholder || 'field', readableFieldName(label) || readableFieldName(placeholder) || '', {
        insert: (path, opts) => acceptPath(path, opts || {}),
        accept: ({ source, shape }) => {
            const path = legacyPathOf(source, sample);
            if (path) acceptPath(path, { source, shape });
        },
    });

    const onEditorInput = () => {
        // Autocomplete: `{{` opens it in Text mode, a rooted or root-prefix
        // partial in Formula mode. The picker follows the typing WITHOUT
        // taking focus ('tr' of 'true' must not move the 'ue' into its search).
        const token = autocompleteToken(inputRef.current?.textBeforeCaret() || '', mode);
        if (token) {
            autocompleteLength.current = token.length;
            picker.openPicker(inputRef.current?.element, { initialQuery: token.query, autoFocus: false });
        } else if (autocompleteLength.current && picker.open) {
            autocompleteLength.current = 0;
            picker.closePicker();
        }
    };

    const onPick = (path: string, opts: InsertOpts = {}) => {
        const swallow = autocompleteLength.current;
        const pill = pillTarget.current;
        autocompleteLength.current = 0;
        pillTarget.current = null;
        picker.closePicker();
        acceptPath(path, { ...opts, pill, swallow });
    };
    const closePicker = () => { pillTarget.current = null; autocompleteLength.current = 0; picker.closePicker(); };

    const toggleMode = () => {
        const next: Mode = mode === 'fixed' ? 'expression' : 'fixed';
        setMode(next);
        // Translate where both modes spell the same thing (one reference);
        // leave anything else exactly as typed.
        emit(translateForMode(text, next), next);
        inputRef.current?.focus();
    };

    const onDrop = (e: DragEvent) => {
        const path = getBindingDropPath(e);
        if (!path) return;
        const source = sourceFromPath(path);
        acceptPath(path, { raw: e.altKey, at: { x: e.clientX, y: e.clientY }, source });
    };

    const binding = bindingFromInput(text, mode);
    // Parse-check a formula with the server's own evaluator (the shared expr
    // mirror): advisory amber, a half-typed formula is normal.
    const exprError = useMemo(() => {
        if (mode !== 'expression') return null;
        const src = String(text || '').trim();
        if (!src) return null;
        try { compileExpr(src); return null; } catch (e) {
            return `${t('routines.builder.expr_invalid', 'Not valid yet')} — ${(e as Error).message}`;
        }
    }, [mode, text, t]);

    const modeButton = (target: Mode, Icon: typeof Type, word: string, title: string, extra = '') => (
        <button
            type="button"
            onClick={() => { if (mode !== target) toggleMode(); }}
            aria-pressed={mode === target}
            title={title}
            className={`px-1.5 py-0.5 text-[11px] flex items-center justify-center gap-1 transition-colors ${FOCUS_RING_INSET} ${extra}
                ${mode === target
                    ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'}`}
        >
            <Icon size={12} /><span>{word}</span>
        </button>
    );

    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                    {!hideLabel && <FieldLabelRow label={label} required={required} expectKind={expectKind} hint={hint} autoMapped={autoMapped} />}
                </div>
                {askAssistant && (exprError || (required && !String(text || '').trim())) && (
                    <button type="button" onClick={() => askAssistant({ label, value, expectKind })} className="inline-flex items-center gap-1 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_9%,transparent)] hover:bg-[var(--bg-secondary)]">
                        <Sparkles size={11} />{t('routines.assistant.map_field', 'Let AI map it')}
                    </button>
                )}
            </div>
            <div className="group flex items-stretch gap-1">
                <div className="flex-1 min-w-0">
                    <RefTokenInput
                        ref={inputRef}
                        value={text}
                        mode={mode}
                        multiline={multiline}
                        rows={3}
                        onChange={(next: string) => emit(next, mode)}
                        onInput={onEditorInput}
                        onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setFocused(true); onFocusField?.(handle); }}
                        // Clicks in "Comes in" blur the field first; the handle stays valid.
                        onBlur={() => { blurTimer.current = setTimeout(() => setFocused(false), 150); }}
                        onDragOver={onBindingDragOver}
                        onDrop={onDrop}
                        placeholder={placeholder}
                        ariaLabel={label || placeholder || undefined}
                        stepLabelById={pickerCtx.stepLabelById}
                        stepTypeById={pickerCtx.stepTypeById}
                        onPillClick={({ el, path }: { el: Element; path: string }) => {
                            autocompleteLength.current = 0;
                            pillTarget.current = el;
                            picker.openPicker(el, { focusPath: path });
                        }}
                        className={denseInputClass(`w-full ${mode === 'expression' ? 'font-mono' : ''}`)}
                    />
                </div>
                <InsertDataButton
                    onClick={(e: { currentTarget: Element }) => { autocompleteLength.current = 0; picker.openPicker(e.currentTarget); }}
                    open={picker.open}
                />
                {/* In Simple mode the switch exists only for a field that already holds a formula. */}
                {!formulaOnly && (formMode !== 'simple' || mode === 'expression') && (
                    <div role="group" aria-label={t('routines.builder.mode_group', 'Value mode')} className="shrink-0 flex items-center rounded border border-[var(--border-default)] overflow-hidden">
                        {modeButton('fixed', Type, t('routines.builder.mode_text_word', 'Text'),
                            t('routines.builder.mode_text', 'Plain text — type a value. Use {{ }} to insert data from a previous step.'))}
                        {modeButton('expression', FunctionSquare, t('routines.builder.mode_formula_word', 'Formula'),
                            t('routines.builder.mode_expression', 'Expression — compute the value, e.g. steps.s1.output.total > 100'),
                            'font-mono border-l border-[var(--border-default)]')}
                    </div>
                )}
            </div>

            {mode === 'expression' && showExpressionHelp && (
                <div className="space-y-1">
                    {exprError && <div className="text-[10px] text-amber-600 dark:text-amber-400">{exprError}</div>}
                    <button
                        type="button"
                        onClick={() => setHelpOpen(o => !o)}
                        aria-expanded={helpOpen}
                        className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                    >
                        {helpOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {t('routines.builder.what_can_i_write', 'What can I write here?')}
                    </button>
                    {helpOpen && <ExpressionHelpBody />}
                </div>
            )}
            <EmptySlotNote required={required} empty={String(text || '').trim() === ''} />
            <BindingFieldPreview
                binding={binding}
                sample={sample}
                slot={fieldSlot}
                expectShape={expectShape}
                showValue={focused || binding.kind !== 'literal'}
                label={label}
                onChoose={applyBinding}
            />
            <VariablePicker
                {...picker.pickerProps}
                groups={pickerCtx.groups}
                previewSample={sample}
                onPick={onPick}
                onClose={closePicker}
                title={label
                    ? t('mapping.formula.insert_into', 'Insert into {field}', { field: label })
                    : t('mapping.formula.insert', 'Insert a value')}
            />
        </div>
    );
}

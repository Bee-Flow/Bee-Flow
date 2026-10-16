import { useMemo, useRef, useState } from 'react';
import { getBindingDropPath } from './bindingDnd';
import { planDeepPick } from './deepPick';
import { proposePickBinding } from './proposePick';
import { buildValue, parseValue } from './valueParts';
import { bindingFromInput, canonicalRefPath, formatPathForInsert } from '../../../../utils/bindingHelpers';
import type { DeepenHandle } from './deepPick';
import type { ListPickState, ForeachNoteState, ResolverState } from './ValueBuilderViews';
import type { ListPickChoice } from './ListPickChooser';
import type { ValuePart } from './valueParts';
import type { DragEvent } from 'react';

/** The imperative handle of the inline pill text box (RefTokenInput). */
interface InlineHandle {
    insertSnippet(snippet: string): void;
    insertSnippetAt(snippet: string, at: { x: number; y: number }): void;
    replacePill(pill: HTMLElement, snippet: string): void;
}

/** One remedy as the pick pipeline writes it: a whole binding, plus the forEach it may set. */
interface PickedRemedy {
    id: string;
    binding?: unknown;
    forEach?: unknown;
}

interface PickOptions {
    raw?: boolean;
    at?: { x: number; y: number } | null;
}

/** What Undo restores after a choice that made the step run per row. */
interface UndoState {
    value: unknown;
    custom?: (() => void) | null;
    forEach?: null;
    request?: ((forEach: unknown) => void) | null;
}

interface UseValuePickArgs {
    value: unknown;
    onChange?: ((binding: unknown) => void) | null;
    onRequestForEach: ((forEach: unknown) => void) | null;
    deepenForEach: DeepenHandle | null;
    expectShape: string;
    expectKind: string | null;
    label: string | null;
    allowForEach: boolean;
    sampleRoot: unknown;
    inline: boolean;
    parts: ValuePart[];
    emit: (parts: ValuePart[]) => void;
    inlineRef: { current: InlineHandle | null };
    /** Which part the open picker will write into (-1 = append a new one). */
    pickTarget: { current: number };
    /** The pill a click is re-picking for (inline mode). */
    pillTarget: { current: HTMLElement | null };
    picker: { pickerProps: { anchorEl: HTMLElement | null }; closePicker: () => void };
    /** The field announcing itself to the Input panel; null outside a form. */
    onFocusField: ((handle: FieldHandle) => void) | null;
    /** The label of the form row this editor sits in, when it has no label of its own. */
    rowLabel: string | null | undefined;
}

/** What the field parks in the Input panel: a click or drag on an upstream field lands in this field. */
interface FieldHandle {
    id: string;
    label: string;
    insert: (path: string, opts?: PickOptions) => void;
}

/**
 * ValueBuilder's pick pipeline: what happens between "the author picked a path"
 * and "a binding is written". Owns the answers that wait on the author (the list
 * chooser, the mismatch resolver, the "now runs once per row" note) and the Undo
 * record; everything it writes goes out through `onChange` / `onRequestForEach`.
 *
 * WHETHER to ask, and WHICH question, comes from mapping/mismatch.js and
 * nowhere else. The answers land in two presenters:
 *   a list, table or group picked INTO the field → the inline resolver
 *           under it, which writes mismatch.js's own default first (join /
 *           asTable / groupSummary) so the field is never left holding the
 *           raw value while the question is on screen;
 *   a list re-picked onto an existing CHIP → ListPickChooser beside that
 *           chip, with its separator control; it writes nothing until
 *           the author answers.
 */
export default function useValuePick(args: UseValuePickArgs) {
    const {
        value, onChange, onRequestForEach, deepenForEach, expectShape, expectKind, label, allowForEach, sampleRoot,
        inline, parts, emit, inlineRef, pickTarget, pillTarget, picker, onFocusField, rowLabel,
    } = args;
    // The list chooser: a pick that resolved to a list, awaiting the user's
    // answer. { path, shape, anchorEl, index } | null.
    const [listPick, setListPick] = useState<ListPickState | null>(null);
    // A pick that resolved to a GROUP or a TABLE: the default remedy is
    // already written and this box asks whether it was the right one.
    const [resolver, setResolver] = useState<ResolverState | null>(null);
    // What to restore if the user presses Undo after a foreach choice.
    const undoRef = useRef<UndoState | null>(null);
    const [foreachNote, setForeachNote] = useState<ForeachNoteState | null>(null);

    // The pick pipeline. `opts.raw` (Alt held, or "insert it as it is") skips
    // every question; so does a slot whose shape is unknown — the gate is
    // POSITIVE, so App Studio, custom rows and Set fields behave exactly as
    // they did before this editor learned to ask anything.
    const proposePick = (path: unknown, anchorEl: HTMLElement | null, opts: PickOptions = {}) => {
        // The canonical spelling, whatever the source handed over (a drag
        // from an output table may say `headers.content-type`): every answer
        // below is a ref or a formula over it, and a formula reads only the
        // canonical spelling as that same path.
        let clean = canonicalRefPath(String(path || '').trim());
        if (!clean) return;
        const index = pickTarget.current;
        pickTarget.current = -1;
        if (opts.raw || expectShape !== 'scalar') { insertPath(clean, index, opts.at); return; }
        // WHICH value goes in, and how a list, table or group is shaped when it
        // does not fit, is one pure decision (proposePick.proposePickBinding) the
        // phone makes identically.
        const pick = proposePickBinding(clean, sampleRoot, { slot: label, expectKind, expectShape, allowForEach });
        clean = pick.path;
        // A value from a list inside a list (Attachments ▸ Attachment id while
        // the step runs per email, or Orders ▸ Line items ▸ Sku): one run per
        // INNER item, the outer item kept (deepPick.ts). Never joined.
        const deep = planDeepPick(clean, { deepenForEach, canForEach: allowForEach && !!onRequestForEach, sampleRoot });
        if (deep) {
            onChange?.(deep.binding);
            let orphans: string[] = [];
            if (deep.plan && deepenForEach) {
                const res = deepenForEach.apply(deep.plan, deep.newItem);
                undoRef.current = { value, custom: res?.undo || null };
                orphans = res?.orphans || [];
            } else {
                undoRef.current = { value, forEach: null, request: onRequestForEach };
                onRequestForEach?.(deep.forEach);
            }
            setForeachNote({ runs: deep.runs, noun: deep.itemVar, orphans });
            return;
        }
        // A pick that fits goes in as it is. One that does not gets the quiet
        // default written at once (round 2, artboard 2a): the field is never
        // left holding the raw list while the question is on screen, and the
        // other answers wait under "More" (Advanced).
        const chosen = pick.remedy;
        if (!chosen) { insertPath(clean, index, opts.at); return; }
        applyRemedy(chosen);
        // The one default that changes how the step RUNS says so, with Undo.
        if (chosen.id === 'foreach') {
            setForeachNote({ runs: pick.remedies?.shape?.rows ?? pick.remedies?.count ?? null });
        }
        setResolver({ path: clean, actualKind: pick.actualKind, expectedKind: pick.expectedKind, selectedId: chosen.id });
    };
    // Write one remedy's binding. A remedy is the WHOLE value (it is an
    // expression over the picked path), so it replaces the parts rather than
    // joining onto them — the same thing BindingField does with applyBinding.
    const applyRemedy = (r: PickedRemedy | null | undefined) => {
        if (!r) return;
        if (r.id === 'foreach' && onRequestForEach) {
            // Keep the callback that set it: once the step runs per item the
            // editor may stop offering one, and Undo must still clear it.
            undoRef.current = { value, forEach: null, request: onRequestForEach };
            onRequestForEach(r.forEach);
        }
        onChange?.(r.binding);
    };
    const onResolverChoose = (r: PickedRemedy | null | undefined) => {
        if (!r) return;
        applyRemedy(r);
        setResolver(prev => (prev ? { ...prev, selectedId: r.id } : prev));
    };
    const insertPath = (path: string, index: number, at: { x: number; y: number } | null = null) => {
        if (inline) {
            const snippet = formatPathForInsert(path, 'fixed');
            if (!snippet) return;
            if (at) inlineRef.current?.insertSnippetAt(snippet, at);
            else inlineRef.current?.insertSnippet(snippet);
            return;
        }
        const next = [...parts];
        const picked = canonicalRefPath(path);
        if (index >= 0 && next[index]) next[index] = { type: 'data', path: picked };
        else next.push({ type: 'data', path: picked });
        emit(next);
    };
    const onPick = (path: string, opts: PickOptions = {}) => {
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

    const onListChoice = (choice: ListPickChoice | null | undefined) => {
        const pick = listPick;
        setListPick(null);
        if (!pick || !choice) return;
        if (choice.mode === 'foreach' && onRequestForEach) {
            undoRef.current = { value, forEach: null, request: onRequestForEach };
            onRequestForEach(choice.forEach);
            onChange?.(choice.binding);
            const runs = pick.shape?.rows ?? pick.shape?.count;
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
        // A deepened forEach restores the step as a whole (its forEach and the
        // fields it moved), this field included.
        if (undo.custom) { undo.custom(); return; }
        (undo.request || onRequestForEach)?.(null);
        onChange?.(undo.value ?? { kind: 'literal', value: '' });
    };
    // What the text box emits, normalised through valueParts so a lone
    // pill is still a ref and plain words are still a literal — the same
    // shapes the chip editor writes.
    const emitInline = (text: string) => {
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
        label: label || rowLabel || '',
        insert: (path, opts) => { pickTarget.current = -1; proposePick(path, null, opts); },
    });
    const onDrop = (e: DragEvent<HTMLElement>) => {
        const path = getBindingDropPath(e);
        if (!path) return;
        pickTarget.current = -1;
        proposePick(path, e.currentTarget, { raw: e.altKey, at: { x: e.clientX, y: e.clientY } });
    };

    return {
        listPick, setListPick, resolver, setResolver, foreachNote,
        proposePick, onPick, onResolverChoose, onListChoice, undoForeach, emitInline, broadcast, onDrop,
    };
}

/**
 * The value as the visual editor sees it: the parsed parts, whether they show
 * as ONE text box with the references as pills in it (design 2a: "just type,
 * fields may go in between" — whenever the value is text, or text and data
 * mixed; a single picked value keeps its chip and the "use it as" control, and
 * "Add text" beside that chip switches to composing), and the edits on them.
 */
export function useValueParts(value: Parameters<typeof parseValue>[0], onChange: ((binding: unknown) => void) | null | undefined) {
    const parsed = useMemo(() => parseValue(value), [value]);
    const parts = parsed.parts;
    const [composing, setComposing] = useState(false);
    const inlineRef = useRef<InlineHandle | null>(null);
    // The pill a click is re-picking for (inline mode).
    const pillTarget = useRef<HTMLElement | null>(null);
    const singleData = parts.length === 1 && parts[0].type === 'data';
    const inline = parsed.supported && !(parts.length === 1 && parts[0].type === 'json') && (composing || !singleData);
    const inlineText = parts.map(p => (p.type === 'data' ? `{{${p.path}}}` : p.text)).join('');
    const inlineRows = Math.min(12, Math.max(1, inlineText.split('\n').length));
    const emit = (nextParts: ValuePart[], nextTransform = parsed.transform, nextArg = parsed.transformArg, nextArg2 = parsed.transformArg2) => {
        // A transform belongs to a single picked value; joining parts drops it
        // (the control that sets it is hidden in that shape anyway).
        const dataCount = nextParts.filter(p => p.type === 'data').length;
        const keep = dataCount === 1 && nextParts.length === 1 ? nextTransform : null;
        onChange?.(buildValue(nextParts, keep, keep ? nextArg : null, keep ? nextArg2 : null));
    };
    const setText = (index: number, text: string) => {
        const next = [...parts];
        if (next[index]) next[index] = { type: 'text', text };
        else next.push({ type: 'text', text });
        emit(next);
    };
    const removeAt = (index: number) => emit(parts.filter((_, i) => i !== index));
    return { parsed, parts, setComposing, inline, inlineText, inlineRows, inlineRef, pillTarget, emit, setText, removeAt };
}

/**
 * The text a BindingInput edits, and back — the phone's version of the web's
 * value builder (agent-hub `Builder/mapping/ValueBuilder.jsx`, `TemplateField`,
 * `PathField`), which lets an author type around `{{path}}` pills.
 *
 * The field's text is the plain text — data written as `{{path}}` — and
 * PillTextInput draws each reference as a pill inside it, named the way the
 * web names them (bindings/valueParts `describeDataPath`). Three value shapes:
 *
 *   binding   a `{kind, …}` binding (tool inputs, Edit data fields, a call's
 *             inputs). Text mode goes through valueParts' visual model:
 *             `parseValue` → parts → text, text → parts → `buildValue`, so a
 *             `{{steps.a.output.x}}` alone is a ref and mixed text a template,
 *             exactly the kinds the web writes. Anything the visual model does
 *             not cover (a transform, a JSON pick, an expression) is edited in
 *             FORMULA mode as the expression itself.
 *   template  a plain string the runtime interpolates (a prompt, a body).
 *   path      a bare path (`steps.x.output.items`) — a list to work through,
 *             a value to scan. A pick replaces it whole.
 *   expression a free expression stored as its text (a raw condition): a
 *             pick goes in at the caret as a bare path, around what is typed.
 */

import {
    bindingFromInput,
    buildValue,
    describeDataPath,
    formatPathForInsert,
    inputFromBinding,
    insertAtSelection,
    isDataPath,
    parseValue,
    renderBindingValue,
    scanExprPaths,
    type Binding,
    type BindingValue,
    type StepLabelMap,
    type TextEdit,
    type ValuePart,
} from '@/features/flow-editor/bindings';
import { isStructuredBinding, structuredFromText } from '@/features/flow-editor/bindings/bindingHelpers';
import { scanTemplate } from '@/shared/expr';

export type BindingInputMode = 'binding' | 'template' | 'path' | 'expression';

/** A one-click adjustment of a single picked value (valueTransforms): `formatDate(path, "D MMMM YYYY")`. */
export interface Adjustment {
    transform: string;
    arg: string | null;
    arg2: string | null;
}

/** A field read out of JSON text another step returned: `parseJson(path, "customer.name")`. */
export interface JsonPick {
    path: string;
    jsonPath: string;
}

export interface EditableText {
    text: string;
    /** The binding is an expression, edited as one (binding mode only). */
    formula: boolean;
    /** The adjustment of the one picked value the text holds, if any (binding mode only). */
    adjust?: Adjustment | null;
    /** The whole value is one JSON pick, shown as its pill (the text is then empty). */
    pick?: JsonPick | null;
}

/** What a value holds besides its text. */
export type TextExtras = Pick<EditableText, 'adjust' | 'pick'>;

// Placeholders are found with the runtime's quote-aware scan (scanTemplate):
// `{{ x["a}}b"] }}` is ONE reference, exactly as the run reads it.

function asText(value: unknown): string {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
}

/** Parts → text, data written as `{{path}}`. */
export function partsToText(parts: readonly ValuePart[]): string {
    return parts.map((p) => (p.type === 'text' ? p.text : `{{${p.path}}}`)).join('');
}

/**
 * Text → the visual parts, or null when a `{{ }}` holds something that is not
 * a pickable path (a hand-written formula inside a template).
 */
export function textToParts(text: string): ValuePart[] | null {
    const parts: ValuePart[] = [];
    for (const p of scanTemplate(text)) {
        if (p.type === 'text') {
            parts.push({ type: 'text', text: p.value });
            continue;
        }
        if (!isDataPath(p.inner)) return null;
        parts.push({ type: 'data', path: p.inner });
    }
    return parts;
}

/**
 * What the field shows for a stored value. A single picked value with an
 * adjustment (`upper(…)`, `formatDate(…, "…")`) is shown as its pill with the
 * adjustment beside it, as the web's value builder shows it — not as a formula.
 */
export function bindingToText(value: unknown, mode: BindingInputMode): EditableText {
    if (mode !== 'binding' || value == null || typeof value !== 'object') return { text: asText(value), formula: false };
    const parsed = parseValue(value as BindingValue);
    const only = parsed.parts.length === 1 ? parsed.parts[0] : null;
    if (parsed.supported && !parsed.transform && only?.type === 'json') {
        return { text: '', formula: false, pick: { path: only.path, jsonPath: only.jsonPath } };
    }
    const visual = parsed.supported && parsed.parts.every((p) => p.type !== 'json');
    if (visual) {
        const text = partsToText(parsed.parts);
        if (!parsed.transform) return { text, formula: false };
        return { text, formula: false, adjust: { transform: parsed.transform, arg: parsed.transformArg, arg2: parsed.transformArg2 } };
    }
    const { mode: inputMode, text } = inputFromBinding(value as BindingValue);
    return { text, formula: inputMode === 'expression' };
}

/**
 * A STRUCTURED value — a map of bindings (how the AI builder stores an object
 * parameter), a list, an object literal — that a binding field can only show
 * as its JSON text; null for anything else. The runtime resolves it as a
 * structure, so an edit must go back into that structure
 * (structuredTextToValue), never become one string of JSON.
 */
export function structuredOrigin(value: unknown, mode: BindingInputMode): unknown {
    return mode === 'binding' && isStructuredBinding(value) ? value : null;
}

/**
 * Edited JSON text back into the shape of the structured value it was opened
 * from (a literal stays a literal, a map of bindings a map); null while the
 * text is not a JSON object or list, and then nothing is saved — the web's
 * BindingField rule.
 */
export function structuredTextToValue(text: string, origin: unknown): unknown {
    return structuredFromText(text, origin);
}

/** Is the text exactly one picked value — the only shape an adjustment applies to? */
export function canAdjust(text: string): boolean {
    const parts = textToParts(text);
    return parts?.length === 1 && parts[0]?.type === 'data';
}

/** Text mode: the visual parts, a JSON pick, or — for a `{{ }}` the pills cannot show — fixed text. */
function visualBinding(text: string, { adjust, pick }: TextExtras): Binding {
    if (pick && !text) return buildValue([{ type: 'json', path: pick.path, jsonPath: pick.jsonPath }]);
    const parts = textToParts(text);
    if (!parts) return bindingFromInput(text, 'fixed');
    // An adjustment belongs to ONE picked value; text around it drops it (the web's rule).
    if (!adjust || !canAdjust(text)) return buildValue(parts);
    return buildValue(parts, adjust.transform, adjust.arg, adjust.arg2);
}

/** What a typed text means, in the field's shape. */
/**
 * A path or formula takes bare paths: a `{{path}}` pasted into one (the Input
 * tab copies that form, for text fields) loses its braces, or the runner
 * would look for a field literally called "{{steps…}}".
 */
export function unwrapRefs(text: string): string {
    return scanTemplate(text).map((p) => (p.type === 'text' ? p.value : isDataPath(p.inner) ? p.inner : p.raw)).join('');
}

/** A field whose text is an expression: a path, a formula, a raw condition. */
export function takesBarePaths(mode: BindingInputMode, formula: boolean): boolean {
    return formula || mode === 'path' || mode === 'expression';
}

export function textToBinding(text: string, mode: BindingInputMode, formula = false, extras: TextExtras = {}): Binding | string {
    if (mode !== 'binding') return mode === 'template' ? text : unwrapRefs(text).trim();
    if (formula) return bindingFromInput(unwrapRefs(text), 'expression');
    return visualBinding(text, extras);
}

/**
 * A picked path into the text at the selection: `{{path}}` in text, the bare
 * path in a formula; a path field takes the path whole. Always the canonical
 * spelling (`["content-type"]`). In a formula the pick is its own operand: put
 * straight against a name or a closing bracket it would fuse into one bogus
 * path (`…emailsteps.b…`) that resolves to nothing.
 */
export function insertPath(
    text: string,
    selection: { start?: number | null; end?: number | null } | null,
    path: string,
    { mode, formula = false }: { mode: BindingInputMode; formula?: boolean },
): TextEdit {
    if (mode === 'path') {
        const whole = formatPathForInsert(path, 'expression');
        return { value: whole, caret: whole.length };
    }
    const expression = formula || mode === 'expression';
    let snippet = formatPathForInsert(path, expression ? 'expression' : 'fixed');
    if (expression) {
        const start = selection?.start ?? text.length;
        const end = selection?.end ?? text.length;
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- before is only tested by /[A-Za-z0-9_$\])"']$/, one character class anchored at $ with no quantifier: linear
        const before = text.slice(0, start);
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- after is only tested by /^[A-Za-z0-9_$(["']/, one character class anchored at ^ with no quantifier: constant time
        const after = text.slice(end);
        const pre = /[A-Za-z0-9_$\])"']$/.test(before) ? ' ' : '';
        const post = /^[A-Za-z0-9_$(["']/.test(after) ? ' ' : '';
        snippet = `${pre}${snippet}${post}`;
    }
    return insertAtSelection(text, selection, snippet);
}

export interface TextChip {
    path: string;
    /** Where the reference sits in the text, so a chip can take it out again. */
    start: number;
    end: number;
    name: string;
    suffix: string;
    missing: boolean;
}

// The roots a formula's chips name; the paths are found the way the engine reads them.
const CHIP_ROOTS = ['steps', 'trigger', 'vars', 'loop', 'item', '_index'];

function chip(path: string, start: number, end: number, labels: StepLabelMap): TextChip {
    const { name, suffix, missing } = describeDataPath(path, labels);
    return { path, start, end, name, suffix, missing };
}

/** The data references in a text, in order, each named for a person. */
export function chipsIn(text: string, expression: boolean, labels: StepLabelMap = null): TextChip[] {
    const out: TextChip[] = [];
    if (expression) {
        let at = 0;
        for (const part of scanExprPaths(text, CHIP_ROOTS)) {
            const piece = 'path' in part ? part.path : part.text;
            // A bare root (`item`, `trigger` alone) stays text, as it always did; `_index` is a value.
            const named = 'path' in part && (part.path === '_index' || /[.[]/.test(part.path));
            if (named && isDataPath(piece)) out.push(chip(piece, at, at + piece.length, labels));
            at += piece.length;
        }
        return out;
    }
    for (const p of scanTemplate(text)) {
        if (p.type === 'ref' && isDataPath(p.inner)) out.push(chip(p.inner, p.start, p.end, labels));
    }
    return out;
}

/**
 * The same value, written as a formula: a template becomes `concat(…)`, a
 * pill its bare path, fixed text a quoted string — nothing is lost.
 */
export function toFormula(text: string, extras: TextExtras = {}): EditableText {
    return { text: renderBindingValue(textToBinding(text, 'binding', false, extras)), formula: true };
}

/**
 * A formula back as plain text with pills, or null when it is more than the
 * text editor can show (a comparison, a function) — the switch then stays put
 * rather than drop the formula.
 */
export function fromFormula(text: string): EditableText | null {
    if (!text.trim()) return { text: '', formula: false };
    const shown = bindingToText(bindingFromInput(text, 'expression'), 'binding');
    return shown.formula ? null : shown;
}

/** How a chip reads: "gmail search ▸ Total", or just the name. */
export function chipLabel(c: Pick<TextChip, 'name' | 'suffix'>): string {
    return c.suffix ? `${c.name} ▸ ${c.suffix}` : c.name;
}

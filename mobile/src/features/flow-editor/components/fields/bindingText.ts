/**
 * The text a BindingInput edits, and back — the phone's version of the web's
 * value field, which lets an author type around `{{path}}` pills.
 *
 * The field's text is the plain text — data written as `{{path}}` — and
 * PillTextInput draws each reference as a pill inside it, named the way the
 * web names them (bindings/dataPath `describeDataPath`). Four value shapes:
 *
 *   binding   a `{kind, …}` binding (tool inputs, Edit data fields, a call's
 *             inputs). `{{steps.a.output.x}}` alone is a ref, mixed text a
 *             template, plain text a literal — the kinds the web writes.
 *             Anything else (a function, a comparison) is edited in FORMULA
 *             mode as the expression itself. A pick or a composed text is
 *             the shared mapping core's (features/flow-editor/valueSlot):
 *             a pick is never edited as text, a composed text is (below).
 *   template  a plain string the runtime interpolates (a prompt, a body), or
 *             a composed text stored there.
 *   path      a bare path (`steps.x.output.items`) — a list to work through,
 *             a value to scan. A pick replaces it whole.
 *   expression a free expression stored as its text (a raw condition): a
 *             pick goes in at the caret as a bare path, around what is typed.
 *
 * A composed text (`{ kind: 'compose', parts }`) is edited as raw text with a
 * marker per value (valueSlot/composeText), its parts table carried beside
 * the text, and written back as the compose it spells: never as a `{{ }}`
 * template, whose lists and records render differently.
 */

import {
    bindingFromInput,
    describeDataPath,
    formatPathForInsert,
    inputFromBinding,
    insertAtSelection,
    isDataPath,
    type Binding,
    type BindingValue,
    type StepLabelMap,
    type TextEdit,
} from '@/features/flow-editor/bindings';
import { renderBindingValue } from '@/features/flow-editor/model/route/bindingText';
import { composeToText, plainText, textToCompose } from '@/features/flow-editor/valueSlot/composeText';
import { isCompose, isPick, type ComposeBinding, type PickPart } from '@/shared/mapping';

export type BindingInputMode = 'binding' | 'template' | 'path' | 'expression';

/** A field read out of JSON text another step returned: `parseJson(path, "customer.name")`. */
export interface JsonPick {
    path: string;
    jsonPath: string;
}

export interface EditableText {
    text: string;
    /** The binding is an expression, edited as one (binding mode only). */
    formula: boolean;
    /** The whole value is one JSON pick, shown as its pill (the text is then empty). */
    pick?: JsonPick | null;
    /** The text is a composed text: its value parts, which the text's markers name. */
    compose?: PickPart[] | null;
}

/** What a value holds besides its text. */
export type TextExtras = Pick<EditableText, 'pick' | 'compose'>;

/** One run of a text: literal text, or a data path the text holds as `{{path}}`. */
export type TextPart = { type: 'text'; text: string } | { type: 'data'; path: string };

const TOKEN_RE = /\{\{([^}]*)\}\}/g;
// `parseJson(<path>)` / `parseJson(<path>, "<path in the json>")`, escape-free:
// what Edit data's "Pick fields from it" writes.
const JSON_CALL = /^parseJson\(\s*([^,()]+?)\s*(?:,\s*(["'])([^"']*)\2\s*)?\)$/;

/**
 * What a text field (a prompt, a body, a title) hands its BindingInput: the
 * text, or a pick or composed text the v2 mapping stored there — which the
 * field shows and writes back as it is. Anything else reads as empty. A
 * caller that read only strings showed a composed prompt as empty, and the
 * first keystroke wrote the words over it.
 */
export function textFieldValue(value: unknown): unknown {
    if (typeof value === 'string' || isCompose(value) || isPick(value)) return value;
    return value == null || typeof value === 'object' ? '' : String(value);
}

function asText(value: unknown): string {
    if (value == null || typeof value === 'object') return '';
    return typeof value === 'string' ? value : String(value);
}

/** Parts → text, data written as `{{path}}`. */
export function partsToText(parts: readonly TextPart[]): string {
    return parts.map((p) => (p.type === 'text' ? p.text : `{{${p.path}}}`)).join('');
}

/**
 * Text → its parts, or null when a `{{ }}` holds something that is not
 * a pickable path (a hand-written formula inside a template).
 */
export function textToParts(text: string): TextPart[] | null {
    const parts: TextPart[] = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN_RE)) {
        const inner = (m[1] as string).trim();
        if (!isDataPath(inner)) return null;
        const at = m.index as number;
        if (at > last) parts.push({ type: 'text', text: text.slice(last, at) });
        parts.push({ type: 'data', path: inner });
        last = at + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
    return parts;
}

/** A composed text as the field's raw text and its parts. */
function composeEditable(compose: ComposeBinding): EditableText {
    const { raw, parts } = composeToText(compose);
    return { text: raw, formula: false, compose: parts };
}

/** The text of a binding the text editor can show as text (with pills), or null. */
function plainBindingText(b: { kind?: unknown; value?: unknown; path?: unknown }): string | null {
    if (b.kind === 'literal') return b.value == null ? '' : typeof b.value === 'object' ? null : String(b.value);
    if (b.kind === 'ref') {
        const path = String(b.path || '').trim();
        return !path ? '' : isDataPath(path) ? `{{${path}}}` : null;
    }
    if (b.kind === 'template') {
        const text = String(b.value || '');
        return textToParts(text) ? text : null;
    }
    if (b.kind === 'expr') {
        const src = String(b.value || '').trim();
        return !src ? '' : isDataPath(src) ? `{{${src}}}` : null;
    }
    return null;
}

/** What the field shows for a stored value. */
export function bindingToText(value: unknown, mode: BindingInputMode): EditableText {
    if ((mode === 'binding' || mode === 'template') && isCompose(value)) return composeEditable(value);
    if (mode !== 'binding' || value == null || typeof value !== 'object') return { text: asText(value), formula: false };
    // A pick shows as its chip (valueSlot), never as text.
    if (isPick(value)) return { text: '', formula: false };
    const b = value as { kind?: unknown; value?: unknown; path?: unknown };
    const json = b.kind === 'expr' && typeof b.value === 'string' ? JSON_CALL.exec(b.value.trim()) : null;
    if (json && isDataPath(json[1])) return { text: '', formula: false, pick: { path: (json[1] as string).trim(), jsonPath: json[3] ?? '' } };
    const text = plainBindingText(b);
    if (text !== null) return { text, formula: false };
    const { mode: inputMode, text: raw } = inputFromBinding(value as BindingValue);
    return { text: raw, formula: inputMode === 'expression' };
}

function jsonBinding(pick: JsonPick): Binding {
    if (!pick.jsonPath) return { kind: 'expr', value: `parseJson(${pick.path})` };
    const quote = pick.jsonPath.includes('"') ? "'" : '"';
    return { kind: 'expr', value: `parseJson(${pick.path}, ${quote}${pick.jsonPath}${quote})` };
}

/**
 * Text mode: nothing → empty literal, one text → literal, one picked path →
 * ref (or expr), mixed → template, a JSON pick as its call; a `{{ }}` the
 * pills cannot show stays fixed text.
 */
function visualBinding(text: string, pick: JsonPick | null | undefined): Binding {
    if (pick && !text) return jsonBinding(pick);
    const parts = textToParts(text)?.filter((p) => (p.type === 'text' ? p.text !== '' : !!p.path));
    if (!parts) return bindingFromInput(text, 'fixed');
    const only = parts[0];
    if (!only) return { kind: 'literal', value: '' };
    if (parts.length === 1) return only.type === 'text' ? { kind: 'literal', value: only.text } : bindingFromInput(only.path, 'expression');
    return { kind: 'template', value: partsToText(parts) };
}

/** What a typed text means, in the field's shape. */
/**
 * A path or formula takes bare paths: a `{{path}}` pasted into one (the Input
 * tab copies that form, for text fields) loses its braces, or the runner
 * would look for a field literally called "{{steps…}}".
 */
export function unwrapRefs(text: string): string {
    return text.replace(TOKEN_RE, (whole, inner: string) => (isDataPath(inner.trim()) ? inner.trim() : whole));
}

/** A field whose text is an expression: a path, a formula, a raw condition. */
export function takesBarePaths(mode: BindingInputMode, formula: boolean): boolean {
    return formula || mode === 'path' || mode === 'expression';
}

export function textToBinding(text: string, mode: BindingInputMode, formula = false, extras: TextExtras = {}): Binding | ComposeBinding | string {
    if (extras.compose && (mode === 'binding' || mode === 'template')) {
        const compose = textToCompose(text, extras.compose);
        if (compose) return compose;
        // No value left: the text it says, as the field stores text.
        const plain = plainText(text);
        return mode === 'template' ? plain : { kind: 'literal', value: plain };
    }
    if (mode !== 'binding') return mode === 'template' ? text : unwrapRefs(text).trim();
    if (formula) return bindingFromInput(unwrapRefs(text), 'expression');
    return visualBinding(text, extras.pick);
}

/**
 * A picked path into the text at the selection: `{{path}}` in text, the bare
 * path in a formula; a path field takes the path whole.
 */
export function insertPath(
    text: string,
    selection: { start?: number | null; end?: number | null } | null,
    path: string,
    { mode, formula = false }: { mode: BindingInputMode; formula?: boolean },
): TextEdit {
    if (mode === 'path') return { value: path, caret: path.length };
    const snippet = formatPathForInsert(path, formula || mode === 'expression' ? 'expression' : 'fixed');
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

const BARE_PATH_RE = /(?<![\w$.])(?:steps|trigger|vars|loop|item)(?:\.[\w$]+|\[[^\]]*\])+|(?<![\w$.])_index\b/g;

function chip(path: string, start: number, end: number, labels: StepLabelMap): TextChip {
    const { name, suffix, missing } = describeDataPath(path, labels);
    return { path, start, end, name, suffix, missing };
}

/** The data references in a text, in order, each named for a person. */
export function chipsIn(text: string, expression: boolean, labels: StepLabelMap = null): TextChip[] {
    const out: TextChip[] = [];
    if (expression) {
        for (const m of text.matchAll(BARE_PATH_RE)) {
            const at = m.index as number;
            if (isDataPath(m[0])) out.push(chip(m[0], at, at + m[0].length, labels));
        }
        return out;
    }
    for (const m of text.matchAll(TOKEN_RE)) {
        const inner = (m[1] as string).trim();
        const at = m.index as number;
        if (isDataPath(inner)) out.push(chip(inner, at, at + m[0].length, labels));
    }
    return out;
}

/**
 * The same value, written as a formula: a template becomes `concat(…)`, a
 * pill its bare path, fixed text a quoted string — nothing is lost. (A
 * composed text has no formula spelling and never offers the switch.)
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

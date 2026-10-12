/**
 * The VISUAL value model behind ValueBuilder — a binding expressed as an
 * ordered list of parts a non-technical user can assemble by clicking:
 *
 *   [{ type: 'text', text: 'Order ' }, { type: 'data', path: 'item.id' }]
 *
 * Why a second model at all: the stored bindings are written for the runtime
 * (`{{steps.act_4d4307a.output.total}}`), and that string is unreadable — it
 * names a step by its internal id, and it makes the user type `{{ }}` and
 * `lower(...)` by hand to do anything beyond "copy this value". Parts are what
 * the editor renders (a chip with the step's NAME, a text box, a transform
 * chip); this module is the lossless bridge between the two.
 *
 * Round-trip contract: `buildValue(parseValue(b))` is equivalent to `b` for
 * every binding shape this module reports as supported. Anything else — a
 * hand-written expression, a template with a computed interpolation — comes
 * back `supported: false` and the editor keeps its hands off it (it renders
 * the humanised read-only form plus an "edit as formula" escape).
 *
 * Pure module: no React, no DOM. Paths are read with the runtime's grammar
 * (utils/bindingHelpers, over shared/expr/path.mjs) and chips are classified
 * by mapping/refTokens. A path that goes into a FORMULA (`lower(…)`,
 * `join(…)`) is written in its canonical spelling, the one the expression
 * engine reads as the same path: `headers.content-type` resolves as a key in a
 * template, but inside `lower(…)` it would be a subtraction.
 */
import { compile, parseExpr } from '@shared/expr/engine.mjs';
import { parseJsonText, scanTemplate } from '@shared/expr/path.mjs';
import { classifyRef, fieldTailLabel, resolveChipLabel } from './refTokens';
import { bindingFromInput, canonicalRefPath, INLINE_STEP_PATH_RE, refPathTokens } from '../../../../utils/bindingHelpers';

/** Roots a user can PICK. `secrets` is deliberately absent — never a chip. */
const DATA_ROOTS = new Set(['steps', 'trigger', 'vars', 'loop', 'item', '_index']);

// `fn(<path>, "<arg>")` and `fn(<path>, "<arg>", "<arg2>")` — the transforms
// that carry string arguments: join's separator, formatNumber's style,
// formatDate's notation, yesNoText's two words. Arguments are engine string
// literals, escapes and all (a newline separator is stored as `join(p, "\n")`).
const STR = '(?:"((?:[^"\\\\]|\\\\.)*)"|\'((?:[^\'\\\\]|\\\\.)*)\')';

// `parseJson(<source path>)` / `parseJson(<source path>, "<path in the json>")`
// — the shape JsonExtractSection and "Pick fields from it" write. The JSON
// path is an engine string literal with escapes (`"[\"first-name\"]"`): a
// bracket-quoted key needs them, and a chip that only knew escape-free paths
// fell back to "Custom formula" for every such pick.
const JSON_CALL = new RegExp(`^parseJson\\(\\s*([^,()]+?)\\s*(?:,\\s*${STR}\\s*)?\\)$`);
const ARG1_CALL = new RegExp(`^([A-Za-z_$][A-Za-z0-9_$]*)\\(\\s*([^,()]+?)\\s*,\\s*${STR}\\s*\\)$`);
const ARG2_CALL = new RegExp(`^([A-Za-z_$][A-Za-z0-9_$]*)\\(\\s*([^,()]+?)\\s*,\\s*${STR}\\s*,\\s*${STR}\\s*\\)$`);

/** The date notations 2c names, plus the two an author reaches for next. */
export const NL_DATE_LONG = 'D MMMM YYYY';
export const DATE_FORMATS = [
    { value: NL_DATE_LONG, label: '2 september 2026' },
    { value: 'DD-MM-YYYY', label: '02-09-2026' },
    { value: 'YYYY-MM-DD', label: '2026-09-02' },
    { value: 'D MMMM YYYY, HH:mm', label: '2 september 2026, 10:26' },
];

/** The three number formats 2c names ("bedrag · percentage · kaal"). */
export const NUMBER_STYLES = [
    { value: 'amount', label: 'an amount (€ 1.500.000)' },
    { value: 'percent', label: 'a percentage (12,5%)' },
    { value: 'plain', label: 'plain (1.500.000)' },
];

/** Encode a separator as an engine double-quoted string literal's body. */
export function escapeExprString(s) {
    return String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

/**
 * A string argument the call patterns captured (the body of a double- or a
 * single-quoted literal), read by the expression engine's own tokenizer: the
 * editor shows exactly the text the run uses (`\u2022` a bullet, `\r\n` a
 * Windows line break). A copy of the decoding fell behind the engine once
 * and turned `"\u2022 "` into "u2022 " on the next edit.
 */
function stringArg(doubleQuoted, singleQuoted) {
    const body = doubleQuoted ?? singleQuoted;
    if (body == null) return '';
    const q = doubleQuoted != null ? '"' : "'";
    try { return String(parseExpr(`${q}${body}${q}`).v ?? ''); } catch { return body; }
}

/**
 * The one-click value transforms. Each is a single-argument call in the shared
 * expression language (join carries a second, string argument), so a
 * transformed pick stays a plain `fn(path)` — round trippable, and readable in
 * the raw editor for whoever opens it later.
 *
 * `for` says what SHAPE the transform is about ('text' | 'list' | 'any') —
 * used for ORDERING AND ANNOTATION in the dropdown only, never to remove an
 * entry: sample data is often missing or wrong about shapes, and a transform
 * the user can see is a transform they can still reach.
 */
export const VALUE_TRANSFORMS = [
    { id: 'lower', label: 'lowercase', hint: 'Make the text lowercase', for: 'text' },
    { id: 'upper', label: 'UPPERCASE', hint: 'Make the text uppercase', for: 'text' },
    { id: 'trim', label: 'trim spaces', hint: 'Remove spaces around the text', for: 'text' },
    { id: 'number', label: 'as a number', hint: 'Read the value as a number', for: 'any' },
    { id: 'round', label: 'rounded', hint: 'Round to a whole number', for: 'any' },
    { id: 'toStr', label: 'as text', hint: 'Read the value as text', for: 'any' },
    { id: 'first', label: 'just the first one', hint: 'The first item of the list', for: 'list' },
    { id: 'last', label: 'just the last one', hint: 'The last item of the list', for: 'list' },
    { id: 'join', label: 'all of them, joined into text', hint: 'Every value in one piece of text, with a separator', for: 'list', arg: 'separator' },
    { id: 'count', label: 'count of items', hint: 'How many items the list has', for: 'list' },
    // The "in text: choose a format" half of artboard 2c. Each is one call in
    // the shared expression language (server/shared/expr/functions.mjs and its
    // byte-identical FE mirror), so a formatted pick stays a plain `fn(path,
    // "arg")` — round-trippable here and readable in the raw editor.
    { id: 'formatNumber', label: 'as an amount or a percentage', hint: 'Write the number for people: € 1.500.000, 12,5% or 1.500.000', for: 'number', arg: 'style', argDefault: 'amount' },
    { id: 'formatDate', label: 'as a written date', hint: 'Choose the notation: 2 september 2026 or 02-09-2026', for: 'date', arg: 'format', argDefault: NL_DATE_LONG },
    { id: 'yesNoText', label: 'as your own yes / no words', hint: 'Choose what it says for yes and for no', for: 'yesno', arg: 'words', argDefault: 'yes', arg2Default: 'no' },
    { id: 'groupSummary', label: 'as a readable summary', hint: 'One "Label: value" line per field', for: 'group' },
    { id: 'asTable', label: 'as a table', hint: 'A table with one column per field, in the order they appear', for: 'table' },
];

const TRANSFORM_IDS = new Set(VALUE_TRANSFORMS.map(t => t.id));
/** Transforms whose second argument is a quoted string. */
const ARG1_TRANSFORMS = new Set(['join', 'formatNumber', 'formatDate', 'yesNoText']);
/** …and the one that carries a third as well. */
const ARG2_TRANSFORMS = new Set(['yesNoText']);

/** The transform ids VALUE_TRANSFORMS offers, in order — for the pickers. */
export const TRANSFORM_BY_ID = Object.fromEntries(VALUE_TRANSFORMS.map(t => [t.id, t]));

/** Is this a data path the picker could have produced? (The runtime's path grammar.) */
export function isDataPath(s) {
    const tokens = refPathTokens(String(s ?? ''));
    return !!tokens && DATA_ROOTS.has(tokens[0].key);
}

/**
 * A data path inside a FORMULA: one the expression engine itself reads as
 * that path — `fields["Story Points"]` yes, `headers.content-type` no (the
 * engine subtracts there, so showing it as a field would hide what runs).
 */
function isExprDataPath(s) {
    const src = String(s ?? '').trim();
    if (!isDataPath(src)) return false;
    if (INLINE_STEP_PATH_RE.test(src)) return true;
    let ast;
    try { ast = compile(src).ast; } catch { return false; }
    const literalIndex = (e) => e.kind === 'str' || (e.kind === 'num' && Number.isInteger(e.v))
        || (e.kind === 'unop' && e.op === '-' && e.a?.kind === 'num' && Number.isInteger(e.a.v));
    return ast.kind === 'path' && ast.segments.every(seg => seg.kind === 'name' || seg.kind === 'wildcard'
        || seg.kind === 'match' || (seg.kind === 'index' && literalIndex(seg.expr)));
}

/** A picked path as a formula operand: the canonical spelling every engine reads. */
const operand = (path) => canonicalRefPath(path);

/**
 * Binding -> visual parts.
 *
 * Returns `{ supported: true, parts, transform }` or, for anything the visual
 * editor cannot represent faithfully, `{ supported: false, parts: [],
 * transform: null, text }` where `text` is the raw source for display.
 */
export function parseValue(binding) {
    const no = (text = '') => ({ supported: false, parts: [], transform: null, transformArg: null, transformArg2: null, text });
    const yes = (parts, transform = null, transformArg = null, transformArg2 = null) => ({ supported: true, parts, transform, transformArg, transformArg2, text: '' });

    if (binding == null) return yes([]);
    if (typeof binding !== 'object') return yes(textParts(String(binding)));

    if (binding.kind === 'literal') {
        const v = binding.value;
        if (v == null || v === '') return yes([]);
        if (typeof v === 'object') return no(safeJson(v));
        return yes(textParts(String(v)));
    }
    if (binding.kind === 'ref') {
        const path = String(binding.path || '').trim();
        if (!path) return yes([]);
        return isDataPath(path) ? yes([{ type: 'data', path }]) : no(path);
    }
    if (binding.kind === 'template') return parseTemplate(String(binding.value || ''));
    if (binding.kind === 'expr') {
        const src = String(binding.value || '').trim();
        if (!src) return yes([]);
        if (isExprDataPath(src)) return yes([{ type: 'data', path: src }]);
        // A field placed by "Pick fields from it" — shown as a chip like any
        // other pick, because to the user that is exactly what it was.
        const json = JSON_CALL.exec(src);
        if (json && isExprDataPath(json[1])) {
            return yes([{ type: 'json', path: json[1].trim(), jsonPath: stringArg(json[2], json[3]) }]);
        }
        // The argument-carrying calls first — their extra arguments would trip
        // the single-argument matcher below. Two args (yesNoText's yes/no
        // words) before one (join's separator, formatNumber's style,
        // formatDate's notation).
        const two = ARG2_CALL.exec(src);
        if (two && ARG2_TRANSFORMS.has(two[1]) && isExprDataPath(two[2])) {
            return yes(
                [{ type: 'data', path: two[2].trim() }], two[1],
                stringArg(two[3], two[4]), stringArg(two[5], two[6]),
            );
        }
        const one = ARG1_CALL.exec(src);
        if (one && ARG1_TRANSFORMS.has(one[1]) && isExprDataPath(one[2])) {
            return yes([{ type: 'data', path: one[2].trim() }], one[1], stringArg(one[3], one[4]));
        }
        const call = /^([A-Za-z_$][A-Za-z0-9_$]*)\(([^()]*)\)$/.exec(src);
        if (call && TRANSFORM_IDS.has(call[1]) && isExprDataPath(call[2])) {
            return yes([{ type: 'data', path: call[2].trim() }], call[1]);
        }
        return no(src);
    }
    return no(safeJson(binding));
}

function parseTemplate(source) {
    const parts = [];
    // The runtime's own placeholder scan (quote-aware: `{{ x["a}}b"] }}` is one).
    for (const p of scanTemplate(source)) {
        if (p.type === 'text') { parts.push({ type: 'text', text: p.value }); continue; }
        // A `{{ }}` holding anything but a plain pickable path (a function
        // call, an operator) is somebody's hand-written template — leave it be
        // rather than round-tripping it into something subtly different.
        if (!isDataPath(p.inner)) return { supported: false, parts: [], transform: null, transformArg: null, transformArg2: null, text: source };
        parts.push({ type: 'data', path: p.inner });
    }
    return { supported: true, parts, transform: null, transformArg: null, transformArg2: null, text: '' };
}

function textParts(text) {
    return text === '' ? [] : [{ type: 'text', text }];
}

function safeJson(v) {
    try { return JSON.stringify(v); } catch { return ''; }
}

/**
 * Visual parts -> binding. The kind is chosen by SHAPE, exactly the way a
 * hand-written value would be classified:
 *
 *   nothing            -> empty literal        (the field stays, valued null)
 *   one text           -> literal
 *   one data           -> ref / expr           (bindingFromInput picks)
 *   one data + change  -> expr `fn(path)`
 *   mixed              -> template `a {{p}} b`
 *
 * A transform on a mixed value is dropped — the editor only offers it while
 * exactly one data part is present, so this only ever fires on stale state.
 *
 * `transformArg` is the transform's string argument — join's separator
 * (default ', '), formatNumber's style, formatDate's notation, yesNoText's
 * word for yes — and `transformArg2` is yesNoText's word for no. Transforms
 * that take neither ignore both.
 */
export function buildValue(parts, transform = null, transformArg = null, transformArg2 = null) {
    const kept = (Array.isArray(parts) ? parts : []).filter(
        p => p && (p.type === 'text' ? p.text !== '' : !!p.path),
    );
    if (!kept.length) return { kind: 'literal', value: '' };

    // A JSON pick is a function call, and `{{ }}` interpolation can't hold one
    // — so it is always the whole value. The editor never offers to combine it
    // with anything (no add buttons on a JSON chip); this is the belt.
    const json = kept.find(p => p.type === 'json');
    if (json) {
        if (!json.jsonPath) return { kind: 'expr', value: `parseJson(${operand(json.path)})` };
        return { kind: 'expr', value: `parseJson(${operand(json.path)}, "${escapeExprString(json.jsonPath)}")` };
    }

    if (kept.length === 1) {
        const only = kept[0];
        if (only.type === 'text') return { kind: 'literal', value: only.text };
        if (transform && ARG2_TRANSFORMS.has(transform)) {
            const spec = TRANSFORM_BY_ID[transform];
            const a = escapeExprString(transformArg ?? spec?.argDefault ?? '');
            const b = escapeExprString(transformArg2 ?? spec?.arg2Default ?? '');
            return { kind: 'expr', value: `${transform}(${operand(only.path)}, "${a}", "${b}")` };
        }
        if (transform && ARG1_TRANSFORMS.has(transform)) {
            const fallback = transform === 'join' ? ', ' : (TRANSFORM_BY_ID[transform]?.argDefault ?? '');
            return { kind: 'expr', value: `${transform}(${operand(only.path)}, "${escapeExprString(transformArg ?? fallback)}")` };
        }
        if (transform && TRANSFORM_IDS.has(transform)) {
            return { kind: 'expr', value: `${transform}(${operand(only.path)})` };
        }
        return bindingFromInput(only.path, 'expression');
    }

    const value = kept.map(p => (p.type === 'text' ? p.text : `{{${p.path}}}`)).join('');
    return { kind: 'template', value };
}

/**
 * How a picked path is NAMED on screen. Never returns an internal step id when
 * the step is known: `steps.act_4d4307a.output.total` reads as
 * "gmail search ▸ Total", `item.from_email` as "Current row ▸ From email".
 *
 * `stepLabelById` is the inspector's id -> label map (VariablePickerContext).
 */
export function describeDataPath(path, stepLabelById = null) {
    const raw = String(path || '').trim();
    if (!raw) return { name: '', suffix: '', missing: false, source: 'steps' };

    const ref = classifyRef(raw);
    if (ref) {
        const { name, suffix, missing } = resolveChipLabel({ ...ref }, stepLabelById);
        // `missing` means the id isn't in the label map — a deleted step, or a
        // surface that didn't pass one. Either way the id itself is never shown:
        // "Previous step ▸ Total" tells the user as much as `act_4d4307a` does,
        // and the exact path stays in the chip's title for whoever needs it.
        return { name: missing ? 'Previous step' : name, suffix: fieldTailLabel(suffix), missing, source: ref.source };
    }
    const tokens = refPathTokens(raw);
    const root = tokens ? tokens[0].key : raw.split(/[.[]/)[0];
    // The field's own key, read through the grammar: `item["Order date"]`
    // names "Order date", not the quoted spelling.
    const restLabel = () => (tokens && tokens.length > 1 ? fieldTailLabel(canonicalRefPath(raw).slice(String(root).length).replace(/^\./, '')) : '');
    if (root === 'item') {
        return { name: 'Current row', suffix: restLabel(), missing: false, source: 'item' };
    }
    if (raw === '_index') {
        return { name: 'Row number', suffix: '', missing: false, source: 'item' };
    }
    if (root === 'vars') {
        return { name: 'Variable', suffix: restLabel(), missing: false, source: 'vars' };
    }
    return { name: raw, suffix: '', missing: false, source: 'steps' };
}

/** Label for a transform id (for the chip). */
export function transformLabel(id) {
    return VALUE_TRANSFORMS.find(t => t.id === id)?.label || id;
}

/**
 * A field picked out of JSON text ("Pick fields from it"), as the binding
 * that reads it. The run reads JSON text as the value it encodes
 * (shared/expr/path.mjs), so when the source IS JSON text — or already an
 * object — the pick is a plain path: one chip, any key
 * (`steps.http.output.body.data["first name"]`). `parseJson(source, "path")`
 * stays for what only its lenient extraction finds — JSON inside prose, such
 * as an AI answer with a sentence around it — with the path written as an
 * escaped string literal, so a key holding quotes still runs.
 */
export function jsonPickBinding(sourcePath, relPath, sourceValue) {
    const rel = String(relPath ?? '').trim();
    const readable = (typeof sourceValue === 'string' && parseJsonText(sourceValue) !== undefined)
        || (sourceValue !== null && typeof sourceValue === 'object');
    if (rel && readable) {
        const full = `${String(sourcePath ?? '').trim()}${rel.startsWith('[') ? '' : '.'}${rel}`;
        if (isDataPath(full)) return { kind: 'ref', path: canonicalRefPath(full) };
    }
    return buildValue([{ type: 'json', path: String(sourcePath ?? '').trim(), jsonPath: rel }]);
}

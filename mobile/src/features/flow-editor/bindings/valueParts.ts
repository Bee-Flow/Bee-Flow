/**
 * The VISUAL value model behind the value builder — a binding as an ordered
 * list of parts a non-technical user assembles by tapping:
 *
 *   [{ type: 'text', text: 'Order ' }, { type: 'data', path: 'item.id' }]
 *
 * Round-trip contract: `buildValue(parseValue(b))` is equivalent to `b` for
 * every shape reported as supported; anything else comes back
 * `supported: false` and the editor leaves it alone. Port of agent-hub
 * `Builder/mapping/valueParts.js`; pinned by valueParts.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';
import { compile, parseExpr as parseEngineExpr, parseJsonText, scanTemplate } from '@/shared/expr';

import { bindingFromInput } from './bindingHelpers';
import { classifyRef, fieldTailLabel, resolveChipLabel, type StepLabelMap } from './refTokens';
import type { Binding, BindingValue } from './types';
import { ARG1_TRANSFORMS, ARG2_TRANSFORMS, TRANSFORM_BY_ID, TRANSFORM_IDS } from './valueTransforms';
import { canonicalRefPath, refPathTokens } from './walkPath';

export {
    DATE_FORMATS, NL_DATE_LONG, NUMBER_STYLES, TRANSFORM_BY_ID, VALUE_TRANSFORMS, transformLabel,
} from './valueTransforms';

/** Roots a user can PICK. `secrets` is deliberately absent — never a chip. */
const DATA_ROOTS = new Set(['steps', 'trigger', 'vars', 'loop', 'item', '_index']);
// An expanded flowlet's sub-step path (`steps.<call>/<sub>…`).
const INLINE_STEP_PATH_RE = /^steps\.[A-Za-z_$][\w$]*(?:\/[A-Za-z_$][\w$]*)+(?:\.[\w$]+|\[[^\]]*\])*$/;
// `fn(<path>, "<arg>")` and `fn(<path>, "<arg>", "<arg2>")`, escapes and all.
const STR = '(?:"((?:[^"\\\\]|\\\\.)*)"|\'((?:[^\'\\\\]|\\\\.)*)\')';
// `parseJson(<path>)` / `parseJson(<path>, "<path in the json>")` — the JSON
// path an engine string literal with escapes (a bracket-quoted key needs them).
const JSON_CALL = new RegExp(`^parseJson\\(\\s*([^,()]+?)\\s*(?:,\\s*${STR}\\s*)?\\)$`);
const ARG1_CALL = new RegExp(`^([A-Za-z_$][A-Za-z0-9_$]*)\\(\\s*([^,()]+?)\\s*,\\s*${STR}\\s*\\)$`);
const ARG2_CALL = new RegExp(`^([A-Za-z_$][A-Za-z0-9_$]*)\\(\\s*([^,()]+?)\\s*,\\s*${STR}\\s*,\\s*${STR}\\s*\\)$`);
const CALL = /^([A-Za-z_$][A-Za-z0-9_$]*)\(([^()]*)\)$/;

export type ValuePart =
    | { type: 'text'; text: string }
    | { type: 'data'; path: string }
    | { type: 'json'; path: string; jsonPath: string };

export interface ParsedValue {
    supported: boolean;
    parts: ValuePart[];
    transform: string | null;
    transformArg: string | null;
    transformArg2: string | null;
    text: string;
}

/** Encode a string as an engine double-quoted literal's body. */
export function escapeExprString(s: unknown): string {
    return String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

/**
 * A string argument the call patterns captured (the body of a double- or a
 * single-quoted literal), read by the expression engine's own tokenizer, so
 * the editor shows the text the run uses (`\u2022` a bullet, `\r\n` a line
 * break) and cannot fall behind the engine again.
 */
function stringArg(doubleQuoted: string | undefined, singleQuoted: string | undefined): string {
    const body = doubleQuoted ?? singleQuoted;
    if (body == null) return '';
    const q = doubleQuoted != null ? '"' : "'";
    try {
        const node = parseEngineExpr(`${q}${body}${q}`) as { v?: unknown };
        return String(node.v ?? '');
    } catch {
        return body;
    }
}

/** Is this a data path the picker could have produced? (The runtime's path grammar.) */
export function isDataPath(s: unknown): boolean {
    const tokens = refPathTokens(String(s ?? ''));
    return !!tokens && DATA_ROOTS.has(String((tokens[0] as { key?: unknown }).key));
}

type Seg = { kind: string; expr?: { kind: string; v?: unknown; op?: string; a?: { kind: string; v?: unknown } } };
const literalIndex = (e: Seg['expr']) => !!e && (e.kind === 'str' || (e.kind === 'num' && Number.isInteger(e.v))
    || (e.kind === 'unop' && e.op === '-' && e.a?.kind === 'num' && Number.isInteger(e.a.v)));

/** A data path inside a FORMULA: one the expression engine itself reads as that path. */
function isExprDataPath(s: unknown): boolean {
    const src = String(s ?? '').trim();
    if (!isDataPath(src)) return false;
    if (INLINE_STEP_PATH_RE.test(src)) return true;
    let ast: { kind?: string; segments?: Seg[] };
    try {
        ast = compile(src).ast as { kind?: string; segments?: Seg[] };
    } catch {
        return false;
    }
    return ast.kind === 'path' && (ast.segments || []).every((seg) => seg.kind === 'name' || seg.kind === 'wildcard'
        || seg.kind === 'match' || (seg.kind === 'index' && literalIndex(seg.expr)));
}

/** A picked path as a formula operand: the canonical spelling every engine reads. */
const operand = (path: string) => canonicalRefPath(path);

const no = (text = ''): ParsedValue => ({
    supported: false, parts: [], transform: null, transformArg: null, transformArg2: null, text,
});
const yes = (parts: ValuePart[], transform: string | null = null, arg: string | null = null, arg2: string | null = null): ParsedValue => ({
    supported: true, parts, transform, transformArg: arg, transformArg2: arg2, text: '',
});

function textParts(text: string): ValuePart[] {
    return text === '' ? [] : [{ type: 'text', text }];
}

function safeJson(v: unknown): string {
    try {
        return JSON.stringify(v);
    } catch {
        return '';
    }
}

function parseTemplate(source: string): ParsedValue {
    const parts: ValuePart[] = [];
    // The runtime's quote-aware placeholder scan.
    for (const p of scanTemplate(source)) {
        if (p.type === 'text') {
            parts.push({ type: 'text', text: p.value });
            continue;
        }
        // A `{{ }}` holding anything but a pickable path is hand-written.
        if (!isDataPath(p.inner)) return no(source);
        parts.push({ type: 'data', path: p.inner });
    }
    return yes(parts);
}

/** The argument-carrying transform calls, two arguments before one. */
function parseArgCall(src: string): ParsedValue | null {
    const two = ARG2_CALL.exec(src);
    if (two && ARG2_TRANSFORMS.has(two[1] as string) && isExprDataPath(two[2])) {
        const a = stringArg(two[3], two[4]);
        const b = stringArg(two[5], two[6]);
        return yes([{ type: 'data', path: (two[2] as string).trim() }], two[1] as string, a, b);
    }
    const one = ARG1_CALL.exec(src);
    if (one && ARG1_TRANSFORMS.has(one[1] as string) && isExprDataPath(one[2])) {
        return yes([{ type: 'data', path: (one[2] as string).trim() }], one[1] as string, stringArg(one[3], one[4]));
    }
    return null;
}

function parseExpr(raw: unknown): ParsedValue {
    const src = String(raw || '').trim();
    if (!src) return yes([]);
    if (isExprDataPath(src)) return yes([{ type: 'data', path: src }]);
    // A field placed by "Pick fields from it" — a chip like any other pick.
    const json = JSON_CALL.exec(src);
    if (json && isExprDataPath(json[1])) {
        return yes([{ type: 'json', path: (json[1] as string).trim(), jsonPath: stringArg(json[2], json[3]) }]);
    }
    const withArgs = parseArgCall(src);
    if (withArgs) return withArgs;
    const call = CALL.exec(src);
    if (call && TRANSFORM_IDS.has(call[1] as string) && isExprDataPath(call[2])) {
        return yes([{ type: 'data', path: (call[2] as string).trim() }], call[1] as string);
    }
    return no(src);
}

function parseLiteral(v: unknown): ParsedValue {
    if (v == null || v === '') return yes([]);
    if (typeof v === 'object') return no(safeJson(v));
    return yes(textParts(String(v)));
}

function parseRef(raw: unknown): ParsedValue {
    const path = String(raw || '').trim();
    if (!path) return yes([]);
    return isDataPath(path) ? yes([{ type: 'data', path }]) : no(path);
}

/** Binding → visual parts, or `supported: false` with the raw text for display. */
export function parseValue(binding: BindingValue): ParsedValue {
    if (binding == null) return yes([]);
    if (typeof binding !== 'object') return yes(textParts(String(binding)));
    if (binding.kind === 'literal') return parseLiteral(binding.value);
    if (binding.kind === 'ref') return parseRef(binding.path);
    if (binding.kind === 'template') return parseTemplate(String(binding.value || ''));
    if (binding.kind === 'expr') return parseExpr(binding.value);
    return no(safeJson(binding));
}

function jsonBinding(part: { path: string; jsonPath: string }): Binding {
    if (!part.jsonPath) return { kind: 'expr', value: `parseJson(${operand(part.path)})` };
    return { kind: 'expr', value: `parseJson(${operand(part.path)}, "${escapeExprString(part.jsonPath)}")` };
}

function argBinding(path: string, transform: string, arg: string | null, arg2: string | null): Binding {
    const tr = TRANSFORM_BY_ID[transform];
    if (ARG2_TRANSFORMS.has(transform)) {
        const a = escapeExprString(arg ?? tr?.argDefault ?? '');
        const b = escapeExprString(arg2 ?? tr?.arg2Default ?? '');
        return { kind: 'expr', value: `${transform}(${operand(path)}, "${a}", "${b}")` };
    }
    const fallback = transform === 'join' ? ', ' : tr?.argDefault ?? '';
    return { kind: 'expr', value: `${transform}(${operand(path)}, "${escapeExprString(arg ?? fallback)}")` };
}

function transformedBinding(path: string, transform: string | null, arg: string | null, arg2: string | null): Binding {
    if (!transform) return bindingFromInput(path, 'expression');
    if (ARG1_TRANSFORMS.has(transform)) return argBinding(path, transform, arg, arg2);
    if (TRANSFORM_IDS.has(transform)) return { kind: 'expr', value: `${transform}(${operand(path)})` };
    return bindingFromInput(path, 'expression');
}

function keptPart(p: unknown): p is ValuePart {
    if (!p || typeof p !== 'object') return false;
    const part = p as ValuePart;
    return part.type === 'text' ? part.text !== '' : !!(part as { path?: string }).path;
}

/**
 * Visual parts → binding, the kind chosen by SHAPE: nothing → empty literal,
 * one text → literal, one data → ref/expr, one data + change → `fn(path)`,
 * mixed → template. A JSON pick is always the whole value.
 */
export function buildValue(
    parts: unknown,
    transform: string | null = null,
    transformArg: string | null = null,
    transformArg2: string | null = null,
): Binding {
    const kept = (Array.isArray(parts) ? parts : []).filter(keptPart);
    if (!kept.length) return { kind: 'literal', value: '' };
    const json = kept.find((p) => p.type === 'json');
    if (json) return jsonBinding(json as { path: string; jsonPath: string });
    const only = kept[0] as ValuePart;
    if (kept.length === 1) {
        if (only.type === 'text') return { kind: 'literal', value: only.text };
        return transformedBinding((only as { path: string }).path, transform, transformArg, transformArg2);
    }
    const value = kept.map((p) => (p.type === 'text' ? p.text : `{{${(p as { path: string }).path}}}`)).join('');
    return { kind: 'template', value };
}

export interface DataPathLabel {
    name: string;
    suffix: string;
    missing: boolean;
    source: string;
}

/**
 * How a picked path is NAMED on screen — never an internal step id:
 * `steps.act_4d4307a.output.total` reads "gmail search ▸ Total".
 */
export function describeDataPath(path: unknown, stepLabelById: StepLabelMap = null): DataPathLabel {
    const raw = String(path || '').trim();
    if (!raw) return { name: '', suffix: '', missing: false, source: 'steps' };
    const ref = classifyRef(raw);
    if (ref) {
        const { name, suffix, missing } = resolveChipLabel({ ...ref }, stepLabelById);
        const shown = missing ? t('automations.ndv.prev_step', 'Previous step') : name;
        return { name: shown, suffix: fieldTailLabel(suffix), missing, source: ref.source };
    }
    const tokens = refPathTokens(raw);
    const root = tokens ? String((tokens[0] as { key?: unknown }).key) : (raw.split(/[.[]/)[0] as string);
    // The field's own key, read through the grammar (`item["Order date"]` → "Order date").
    const restLabel = () => (tokens && tokens.length > 1 ? fieldTailLabel(canonicalRefPath(raw).slice(root.length).replace(/^\./, '')) : '');
    if (root === 'item') {
        return { name: t('mobile.flow.path.current_row', 'Current row'), suffix: restLabel(), missing: false, source: 'item' };
    }
    if (raw === '_index') return { name: t('mobile.flow.path.row_number', 'Row number'), suffix: '', missing: false, source: 'item' };
    if (root === 'vars') {
        return { name: t('automations.builder.variable_word', 'Variable'), suffix: restLabel(), missing: false, source: 'vars' };
    }
    return { name: raw, suffix: '', missing: false, source: 'steps' };
}

/**
 * A field picked out of JSON text ("Pick fields from it"), as the binding that
 * reads it: a plain path when the source IS JSON text (or already an object)
 * — the run reads JSON text as the value it encodes — else
 * `parseJson(source, "path")` with the path as an escaped literal, for JSON
 * inside prose that only parseJson's lenient extraction finds.
 */
export function jsonPickBinding(sourcePath: unknown, relPath: unknown, sourceValue: unknown): Binding {
    const rel = String(relPath ?? '').trim();
    const source = String(sourcePath ?? '').trim();
    const readable = (typeof sourceValue === 'string' && parseJsonText(sourceValue) !== undefined)
        || (sourceValue !== null && typeof sourceValue === 'object');
    if (rel && readable) {
        const full = `${source}${rel.startsWith('[') ? '' : '.'}${rel}`;
        if (isDataPath(full)) return { kind: 'ref', path: canonicalRefPath(full) };
    }
    return buildValue([{ type: 'json', path: source, jsonPath: rel }]);
}

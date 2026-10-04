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

import { bindingFromInput } from './bindingHelpers';
import { classifyRef, resolveChipLabel, type StepLabelMap } from './refTokens';
import type { Binding, BindingValue } from './types';
import { ARG1_TRANSFORMS, ARG2_TRANSFORMS, TRANSFORM_BY_ID, TRANSFORM_IDS } from './valueTransforms';
import { humanizeFieldTail } from '../model/displayHelpers';

export {
    DATE_FORMATS, NL_DATE_LONG, NUMBER_STYLES, TRANSFORM_BY_ID, VALUE_TRANSFORMS, transformLabel,
} from './valueTransforms';

/** Roots a user can PICK. `secrets` is deliberately absent — never a chip. */
const DATA_ROOTS = new Set(['steps', 'trigger', 'vars', 'loop', 'item', '_index']);
const PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+|\[[^\]]*\])*$/;
const TEMPLATE_TOKEN = /\{\{([^}]*)\}\}/g;
// `parseJson(<path>)` / `parseJson(<path>, "<path in the json>")`, escape-free.
const JSON_CALL = /^parseJson\(\s*([^,()]+?)\s*(?:,\s*(["'])([^"']*)\2\s*)?\)$/;
// `fn(<path>, "<arg>")` and `fn(<path>, "<arg>", "<arg2>")`, escapes and all.
const STR = '(?:"((?:[^"\\\\]|\\\\.)*)"|\'((?:[^\'\\\\]|\\\\.)*)\')';
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
        .replace(/\t/g, '\\t');
}

/** Mirror of the engine tokenizer's escape decoding. */
function decodeExprString(s: unknown): string {
    let out = '';
    const src = String(s ?? '');
    for (let i = 0; i < src.length; i++) {
        const c = src.charAt(i);
        if (c === '\\' && i + 1 < src.length) {
            const n = src.charAt(i + 1);
            out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
            i++;
        } else {
            out += c;
        }
    }
    return out;
}

/** Is this a data path the picker could have produced? */
export function isDataPath(s: unknown): boolean {
    const text = String(s ?? '').trim();
    if (!text || !PATH_RE.test(text)) return false;
    return DATA_ROOTS.has(text.split(/[.[]/)[0] as string);
}

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
    TEMPLATE_TOKEN.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = TEMPLATE_TOKEN.exec(source))) {
        const inner = (m[1] as string).trim();
        // A `{{ }}` holding anything but a pickable path is hand-written.
        if (!isDataPath(inner)) return no(source);
        if (m.index > last) parts.push({ type: 'text', text: source.slice(last, m.index) });
        parts.push({ type: 'data', path: inner });
        last = m.index + m[0].length;
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) });
    return yes(parts);
}

/** The argument-carrying transform calls, two arguments before one. */
function parseArgCall(src: string): ParsedValue | null {
    const two = ARG2_CALL.exec(src);
    if (two && ARG2_TRANSFORMS.has(two[1] as string) && isDataPath(two[2])) {
        const a = decodeExprString(two[3] ?? two[4] ?? '');
        const b = decodeExprString(two[5] ?? two[6] ?? '');
        return yes([{ type: 'data', path: (two[2] as string).trim() }], two[1] as string, a, b);
    }
    const one = ARG1_CALL.exec(src);
    if (one && ARG1_TRANSFORMS.has(one[1] as string) && isDataPath(one[2])) {
        return yes([{ type: 'data', path: (one[2] as string).trim() }], one[1] as string, decodeExprString(one[3] ?? one[4] ?? ''));
    }
    return null;
}

function parseExpr(raw: unknown): ParsedValue {
    const src = String(raw || '').trim();
    if (!src) return yes([]);
    if (isDataPath(src)) return yes([{ type: 'data', path: src }]);
    // A field placed by "Pick fields from it" — a chip like any other pick.
    const json = JSON_CALL.exec(src);
    if (json && isDataPath(json[1])) {
        return yes([{ type: 'json', path: (json[1] as string).trim(), jsonPath: json[3] ?? '' }]);
    }
    const withArgs = parseArgCall(src);
    if (withArgs) return withArgs;
    const call = CALL.exec(src);
    if (call && TRANSFORM_IDS.has(call[1] as string) && isDataPath(call[2])) {
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
    if (!part.jsonPath) return { kind: 'expr', value: `parseJson(${part.path})` };
    const quote = part.jsonPath.includes('"') ? "'" : '"';
    return { kind: 'expr', value: `parseJson(${part.path}, ${quote}${part.jsonPath}${quote})` };
}

function argBinding(path: string, transform: string, arg: string | null, arg2: string | null): Binding {
    const tr = TRANSFORM_BY_ID[transform];
    if (ARG2_TRANSFORMS.has(transform)) {
        const a = escapeExprString(arg ?? tr?.argDefault ?? '');
        const b = escapeExprString(arg2 ?? tr?.arg2Default ?? '');
        return { kind: 'expr', value: `${transform}(${path}, "${a}", "${b}")` };
    }
    const fallback = transform === 'join' ? ', ' : tr?.argDefault ?? '';
    return { kind: 'expr', value: `${transform}(${path}, "${escapeExprString(arg ?? fallback)}")` };
}

function transformedBinding(path: string, transform: string | null, arg: string | null, arg2: string | null): Binding {
    if (!transform) return bindingFromInput(path, 'expression');
    if (ARG1_TRANSFORMS.has(transform)) return argBinding(path, transform, arg, arg2);
    if (TRANSFORM_IDS.has(transform)) return { kind: 'expr', value: `${transform}(${path})` };
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
        return { name: shown, suffix: humanizeFieldTail(suffix), missing, source: ref.source };
    }
    const root = raw.split(/[.[]/)[0];
    if (root === 'item') {
        const tail = raw.slice(4).replace(/^\./, '');
        return { name: t('mobile.flow.path.current_row', 'Current row'), suffix: humanizeFieldTail(tail), missing: false, source: 'item' };
    }
    if (raw === '_index') return { name: t('mobile.flow.path.row_number', 'Row number'), suffix: '', missing: false, source: 'item' };
    if (root === 'vars') {
        return { name: t('mobile.flow.path.variable', 'Variable'), suffix: humanizeFieldTail(raw.slice(5)), missing: false, source: 'vars' };
    }
    return { name: raw, suffix: '', missing: false, source: 'steps' };
}

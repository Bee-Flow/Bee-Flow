/**
 * Machine identifiers (tool names, step refs, field paths, rule
 * expressions) as text a person reads — a port of the web builder's
 * flow/displayHelpers.js, pinned by summaries.lockstep.test.ts.
 *
 * A non-technical author reads "Subject", never `item.subject`; "Gmail:
 * Search", never `gmail_search`; "‹Classify document›.urgency", never
 * `steps.ai_a9afb3.output.urgency`.
 */

import { fieldShape, formatPath, parsePath, singularKey, type PathToken } from '@/shared/expr';
import { humanizeFieldKey, humanizeToolName } from '@/shared/lib/humanizeKey';

import { pathLabelParts } from './pathGrammar';
import { inferType, isUnaryOp, labelFor } from './route/conditionModel';
import type { ConditionRow } from './route/conditionModel';
import { parseExprToRows } from './route/conditionParse';
import { fileTypeFieldLabel, fileTypeLabel, isFileTypeKey, isQuantifier, quantifierLabel, singularName } from './route/ruleLabels';
import type { DefinitionInput, Translate } from './types';

// Both live in shared/lib, where the run screens (features/automations) reach them too.
export { humanizeFieldKey, humanizeToolName };

interface CatalogLike {
    apps?: { label?: string; actions?: { name?: string; label?: string; integrationLabel?: string }[] }[];
}

/** "Gmail: Search" when the catalog knows the action, "Gmail Search" when not. */
export function actionDisplayLabel(tool: unknown, catalog: CatalogLike | null = null): string {
    const name = String(tool || '');
    if (!name) return '';
    for (const app of catalog?.apps || []) {
        const action = (app?.actions || []).find((a) => a?.name === name);
        if (!action) continue;
        const appLabel = app.label || action.integrationLabel || '';
        const actionLabel = action.label || humanizeToolName(name);
        return appLabel ? `${appLabel}: ${actionLabel}` : actionLabel;
    }
    return humanizeToolName(name);
}

/** "1st", "2nd", "last" — an index the way a person counts. */
function ordinalLabel(index: number): string {
    if (index === -1) return 'last';
    const n = Math.abs(index < 0 ? index : index + 1);
    const v = n % 100;
    const ends: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
    const suffix = v >= 11 && v <= 13 ? 'th' : ends[n % 10] || 'th';
    return index < 0 ? `${n}${suffix} from last` : `${n}${suffix}`;
}

/** Text that is no path: its last dotted segment, brackets dropped. */
function lastSegmentLabel(text: string): string {
    const seg = text.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean).pop();
    return seg ? humanizeFieldKey(seg) : '';
}

/**
 * The readable name of a field path, the way its pill names it (the pills
 * call this too, through bindings/refTokens fieldTailLabel): the field's own
 * key, humanised; a generic key with whose it is (`from.emailAddress.address`
 * → "From ▸ Address"); an index right after the key with which one
 * (`items[0]` → "Items ▸ 1st"). Wildcards and indexes further up are dropped.
 */
export function humanizeFieldTail(fieldPath: unknown): string {
    const tail = String(fieldPath ?? '').trim();
    if (!tail) return '';
    const parts = pathLabelParts(tail);
    if (!parts || !parts.leaf) return parts?.index != null ? ordinalLabel(parts.index) : lastSegmentLabel(tail);
    const name = humanizeFieldKey(parts.leaf) || parts.leaf;
    const head = parts.parent ? `${humanizeFieldKey(parts.parent) || parts.parent} ▸ ${name}` : name;
    return parts.index == null ? head : `${head} ▸ ${ordinalLabel(parts.index)}`;
}

/**
 * `steps.<id>.output.<path>` → `‹Step label›.path`, and the same for loop
 * items and the trigger. An id with no label is kept, so it stays traceable.
 */
export function humanizeExpression(expr: unknown, stepLabelById: Map<string, string> | null = null): string {
    if (!expr || typeof expr !== 'string') return '';
    return expr
        .replace(/steps\.([A-Za-z0-9_]+)\.output(?:\.([A-Za-z0-9_.[\]]+))?/g, (_m, stepId: string, path?: string) => {
            const label = stepLabelById?.get?.(stepId) || stepId;
            return path ? `‹${label}›.${path}` : `‹${label}›`;
        })
        .replace(/\bloop\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_.[\]]+))?/g, (_m, itemVar: string, path?: string) => {
            const head = itemVar ? `‹Each ${itemVar}›` : '‹Each item›';
            return path ? `${head}.${path}` : head;
        })
        .replace(/\btrigger(?:\.([A-Za-z0-9_.[\]]+))?/g, (_m, path?: string) => (path ? `‹Trigger›.${path}` : '‹Trigger›'));
}

const TRIVIAL_RULES = new Set(['', 'true', 'false']);
// Where the field's own part of a path starts, after the root that says whose it is.
const ROOT_SKIP = new Map([['item', 1], ['loop', 2], ['vars', 1]]);

type LabelMap = Pick<Map<string, string>, 'get'> | null;
type RuleField = { name: string; list: string | null; file: boolean };
const tokenKey = (tokens: readonly PathToken[], i: number): unknown => (tokens[i] as { key?: unknown } | undefined)?.key;

function fieldStart(root: string, tokens: readonly PathToken[]): number {
    if (root === 'steps') return tokenKey(tokens, 2) === 'output' ? 3 : 2;
    if (root === 'trigger') return tokenKey(tokens, 1) === 'output' ? 2 : 1;
    return ROOT_SKIP.get(root) ?? 0;
}

/**
 * A rule's field the way the pills name it (humanizeFieldTail): the part
 * after `item` ("From ▸ Email"), and for a whole-run rule the step's label in
 * front ("Classify ▸ Urgency") when the map knows it.
 */
function fieldName(path: string, stepLabelById: LabelMap): string {
    const tokens = parsePath(path);
    if (!tokens?.length) return humanizeFieldTail(path);
    const root = String(tokenKey(tokens, 0));
    const from = fieldStart(root, tokens);
    const tail = tokens.length > from ? humanizeFieldTail(formatPath(tokens.slice(from))) : humanizeFieldKey(root);
    const step = root === 'steps' ? stepLabelById?.get?.(String(tokenKey(tokens, 1) ?? '')) : null;
    return step ? `${step} ▸ ${tail}` : tail;
}

/** `{ name, list, file }` for a row's left side, or null when it is no field (a formula). */
function ruleField(path: string, stepLabelById: LabelMap, t: Translate | null): RuleField | null {
    const shape = path ? fieldShape(path) : null;
    // A path the shapes do not cover (a whole list, `results[*]`) still has a name.
    if (!shape) return path && parsePath(path) ? { name: fieldName(path, stepLabelById), list: null, file: false } : null;
    if (shape.kind === 'fileRecord' || shape.kind === 'fileList') {
        return { name: fileTypeFieldLabel(t), list: shape.kind === 'fileList' ? shape.list : null, file: true };
    }
    if (shape.kind === 'column') return { name: humanizeFieldTail(shape.column), list: shape.list, file: false };
    return { name: fieldName(shape.path, stepLabelById), list: null, file: false };
}

/** The value of a row: a file type's name, “quoted” text, a number bare, a field by its name. */
function ruleValue(row: ConditionRow, field: RuleField, stepLabelById: LabelMap, t: Translate | null): string {
    const v = row.value as { kind?: string; path?: string; value?: unknown } | null;
    if (v?.kind === 'ref' && v.path) return fieldName(v.path, stepLabelById);
    const raw = v?.kind === 'literal' ? v.value : v?.value;
    if (raw === '' || raw == null) return '';
    if (field.file && isFileTypeKey(raw)) return fileTypeLabel(raw, t);
    return typeof raw === 'string' ? `“${raw}”` : String(raw);
}

// An emptiness test on a plural field (`attachments`) reads like the editor's list of
// records ("has at least one"); a card has no sample, so the name is the evidence.
function readsAsRecords(row: ConditionRow, path: string): boolean {
    if (row.op !== 'isEmpty' && row.op !== 'isNotEmpty') return false;
    const tokens = fieldShape(path)?.kind === 'plain' ? parsePath(path) : null;
    const key = tokens && tokens.length > 1 ? tokenKey(tokens, tokens.length - 1) : null;
    return typeof key === 'string' && singularKey(key) !== key;
}

/** The type that picks the operator's words (dates read "is after"); the value is a sentence's only evidence of it. */
function sentenceType(row: ConditionRow, field: RuleField, path: string): string {
    if (field.file) return 'fileType';
    if (readsAsRecords(row, path)) return 'records';
    const v = row.value as { kind?: string; value?: unknown } | null;
    return v?.kind === 'literal' ? inferType(v.value) : 'unknown';
}

/** One row as words: "any attachment · File type is PDF", "Subject contains “isv”"; null when it names no field. */
function rowSentence(row: ConditionRow, stepLabelById: LabelMap, t: Translate | null): string | null {
    const f = row?.field as { kind?: string; path?: string } | null;
    const path = f?.kind === 'ref' ? String(f.path || '') : '';
    const field = ruleField(path, stepLabelById, t);
    if (!field) return null;
    const type = sentenceType(row, field, path);
    const value = isUnaryOp(row.op) ? '' : ruleValue(row, field, stepLabelById, t);
    const body = [field.name, labelFor(row.op, type, t), value].filter(Boolean).join(' ');
    if (!row.quantifier || !field.list || !isQuantifier(row.quantifier)) return body;
    return `${quantifierLabel(row.quantifier, singularName(field.list), t)} · ${body}`;
}

/**
 * A rule as the sentence the canvas and the previews show: "any attachment ·
 * File type is PDF", "Subject contains “isv” and Amount greater than 1000".
 * '' for no rule yet (empty, `true`, `false`); null when the rule is a
 * formula the rows cannot show — never the expression itself.
 */
export function ruleSentence(expr: unknown, stepLabelById: LabelMap = null, t: Translate | null = null): string | null {
    const src = String(expr ?? '').trim();
    if (TRIVIAL_RULES.has(src)) return '';
    const parsed = parseExprToRows(src);
    if (!parsed?.rows?.length) return null;
    const parts = parsed.rows.map((r) => rowSentence(r, stepLabelById, t));
    if (parts.some((p) => p == null)) return null;
    const or = parsed.join === '||';
    const [key, en] = or ? ['condition_node.join.or', 'or'] : ['condition_node.join.and', 'and'];
    return parts.join(` ${t ? t(key, en) : en} `);
}

/** The rule for a card or a preview line: its sentence, and "Custom rule" for a formula the rows cannot show. */
export function describeRuleExpr(expr: unknown, stepLabelById: LabelMap = null, t: Translate | null = null): string {
    return ruleSentence(expr, stepLabelById, t) ?? (t ? t('condition_node.custom.title', 'Custom rule') : 'Custom rule');
}

/** id → label (or id) for the trigger and every step. */
export function buildStepLabelMap(def: DefinitionInput): Map<string, string> {
    const m = new Map<string, string>();
    if (!def) return m;
    for (const s of [def.trigger, ...(def.steps || [])]) if (s) m.set(s.id, s.label || s.id);
    return m;
}

/**
 * id → type for the trigger and every step, loop bodies and branches included: the colour
 * of a reference's pill (the web's pillTint reads the step's family).
 */
export function buildStepTypeMap(def: DefinitionInput): Map<string, string> {
    const m = new Map<string, string>();
    const walk = (nodes: unknown) => {
        if (!Array.isArray(nodes)) return;
        for (const s of nodes as { id?: unknown; type?: unknown; body?: unknown; branches?: unknown }[]) {
            if (typeof s?.id === 'string' && typeof s.type === 'string') m.set(s.id, s.type);
            walk(s?.body);
            if (Array.isArray(s?.branches)) for (const branch of s.branches) walk(branch);
        }
    };
    if (def) walk([def.trigger, ...(def.steps || [])]);
    return m;
}

/**
 * What happens to a Condition's rules when the list it works through changes
 * — the web's routeEditorsModel.ts (flow/settings), pure:
 *   - R11: one level in (`L` → `L[*].k`), rows quantified over `item.k` become
 *     rows on the new item; rows the new item cannot read are kept and named,
 *     never dropped, until the author removes them;
 *   - BFSF-485 F3: a whole-run Condition that reads a list as a whole becomes
 *     one that works through it, its rules moved from `list[*]` onto `item`
 *     (a quantified row becomes the plain row on the item).
 * Rules go through the row model, so a formula the rows cannot show is left
 * exactly as it was written.
 */

import type { TranslateFn } from '@/core/i18n';
import { deepenRows, humanizeFieldKey, humanizeFieldTail, parseExprToRows, serializeRows, type ConditionRow, type RouteRule } from '@/features/flow-editor/model';
import { appendKey, appendWildcard, isFileRecord, parsePath, rebaseRefs, singularKey, type PathToken } from '@/shared/expr';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const refOf = (row: ConditionRow): string => {
    const f = row.field;
    return f && typeof f === 'object' && f.kind === 'ref' ? String(f.path || '') : '';
};

/** The last named key of a path (`messages[*].attachments` → `attachments`); '' when none. */
function lastName(path: string): string {
    const named = (parsePath(path) || []).filter((tok): tok is PathToken & { key: string } => tok.type === 'prop' && typeof tok.key === 'string');
    return named.at(-1)?.key ?? '';
}

/** One entry of the list in words, lower case: "message" for `…messages`, "item" when the list has no name. */
export function itemNameOf(source: string | null | undefined): string {
    const key = lastName(String(source ?? ''));
    if (!key || key === 'output' || key === 'items') return 'item';
    return (humanizeFieldKey(singularKey(key)) || 'item').toLowerCase();
}

/** A field path as a person reads it: `item.from` → "From", `fileType(item)` → "File type". */
export function fieldNameOf(path: string, t: TranslateFn): string {
    if (path.startsWith('fileType(')) return t('condition_node.file_type.label', 'File type');
    const tail = path.startsWith('item.') ? path.slice('item.'.length) : path;
    return humanizeFieldTail(tail) || tail;
}

/**
 * Can an item shaped like `element` give the field at `path`? Null when the
 * path is not about the item (or the element is not a record).
 */
function itemCanRead(path: string, element: unknown): boolean | null {
    const file = path.startsWith('fileType(') && path.endsWith(')');
    const tokens = parsePath(file ? path.slice('fileType('.length, -1) : path);
    if (!tokens || tokens[0]?.type !== 'prop' || tokens[0].key !== 'item') return null;
    if (tokens.length === 1) return file ? isFileRecord(element) : true;
    const first = tokens[1];
    if (first?.type !== 'prop' || !isRecord(element)) return null;
    return Object.prototype.hasOwnProperty.call(element, String(first.key));
}

/** `next` is `prev` one level in (`L` → `L[*].k`): that `k`; else null. */
function oneLevelIn(prev: string, next: string): string | null {
    const a = parsePath(prev);
    const b = parsePath(next);
    if (!a || !b || b.length !== a.length + 2) return null;
    const wild = b[a.length];
    const key = b[a.length + 1];
    if (wild?.type !== 'wild' || key?.type !== 'prop' || typeof key.key !== 'string') return null;
    const samePrefix = a.every((tok, i) => JSON.stringify(tok) === JSON.stringify(b[i]));
    return samePrefix ? key.key : null;
}

function addOnce(into: string[], paths: readonly string[]): void {
    for (const p of paths) if (!into.includes(p)) into.push(p);
}

/** The fields of `rows` an item like `element` lacks; none when the element is unknown. */
function unreadable(rows: readonly ConditionRow[], element: unknown): string[] {
    if (element == null) return [];
    const out: string[] = [];
    for (const row of rows) {
        const path = refOf(row);
        if (path && itemCanRead(path, element) === false) addOnce(out, [path]);
    }
    return out;
}

/**
 * The rules after the list moved from `prev` to `next`, and the fields some
 * rule reads that the new item (`element`, when known) does not have.
 */
export function rulesForSource(rules: readonly RouteRule[], prev: string, next: string, element: unknown): { rules: RouteRule[]; unfit: string[] } {
    const key = oneLevelIn(prev, next);
    const unfit: string[] = [];
    const out = rules.map((rule) => {
        const parsed = parseExprToRows(rule.expr);
        if (!parsed) return rule;
        if (!key) {
            addOnce(unfit, unreadable(parsed.rows, element));
            return rule;
        }
        const deeper = deepenRows(parsed.rows, key);
        addOnce(unfit, element == null ? deeper.unfit : unreadable(deeper.rows, element));
        return { ...rule, expr: serializeRows(deeper.rows, parsed.join) };
    });
    return { rules: out, unfit };
}

/** "Remove those rules": every row that reads one of `paths` goes; the rest stay. */
export function withoutRowsReading(rules: readonly RouteRule[], paths: readonly string[]): RouteRule[] {
    return rules.map((rule) => {
        const parsed = parseExprToRows(rule.expr);
        if (!parsed) return rule;
        const kept = parsed.rows.filter((row) => !paths.includes(refOf(row)));
        if (kept.length === parsed.rows.length) return rule;
        return { ...rule, expr: serializeRows(kept, parsed.join) };
    });
}

// A key no step output carries: `list` is first rebased onto `item.<this>`, so
// the row model's own one-level-in move (deepenRows) can re-root its rows.
const EACH_KEY = '__each_of_list__';

/**
 * One rule rebased from the whole-run `list` onto its item — the web's
 * ruleOnItem (routeEditorsModel.ts). Through the row model first, so a
 * quantified row ("any subject contains isv") becomes the plain row on `item`
 * the rows can show, never a formula they cannot read. A rule the rows cannot
 * show, or a row that cannot move, falls back to rebasing the text.
 */
function ruleOnItem(expr: string, list: string): { expr: string; changed: boolean } {
    const viaText = rebaseRefs(expr, appendWildcard(list), 'item');
    const holder = appendKey('item', EACH_KEY);
    const staged = rebaseRefs(expr, list, holder);
    const parsed = staged.changed ? parseExprToRows(String(staged.value)) : null;
    if (!parsed) return { expr: String(viaText.value), changed: viaText.changed };
    const moved = deepenRows(parsed.rows, EACH_KEY).rows;
    const out = String(rebaseRefs(serializeRows(moved, parsed.join), appendWildcard(holder), 'item').value);
    if (out.includes(EACH_KEY)) return { expr: String(viaText.value), changed: viaText.changed };
    return { expr: out, changed: true };
}

/**
 * "Check each item instead" (F3): one route patch, so one edit and one Undo;
 * the store's write re-points the steps after it (followRouteEdit). Null when
 * no rule reads an item of `list`: working through it would give a rule that
 * never reads the item, so it keeps or drops every item alike.
 */
export function workThroughList(rules: readonly RouteRule[], list: string): { mode: 'items'; source: string; rules: RouteRule[] } | null {
    const next = rules.map((rule) => ({ rule, ...ruleOnItem(rule.expr || '', list) }));
    if (!next.some((n) => n.changed)) return null;
    return { mode: 'items', source: list, rules: next.map((n) => (n.changed ? { ...n.rule, expr: n.expr } : n.rule)) };
}

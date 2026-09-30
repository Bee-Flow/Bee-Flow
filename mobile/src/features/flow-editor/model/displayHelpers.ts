/**
 * Machine identifiers (tool names, step refs, field paths, rule
 * expressions) as text a person reads — a port of the web builder's
 * flow/displayHelpers.js, pinned by summaries.lockstep.test.ts.
 *
 * A non-technical author reads "Subject", never `item.subject`; "Gmail:
 * Search", never `gmail_search`; "‹Classify document›.urgency", never
 * `steps.ai_a9afb3.output.urgency`.
 */

import { humanizeFieldKey, humanizeToolName } from '@/shared/lib/humanizeKey';

import { isUnaryOp, labelFor } from './route/conditionModel';
import type { ConditionRow } from './route/conditionModel';
import { parseExprToRows } from './route/conditionParse';
import type { DefinitionInput } from './types';

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

/** The last named segment of a path, humanised: `results[*].from_email` → "From email". */
export function humanizeFieldTail(fieldPath: unknown): string {
    const cleaned = String(fieldPath || '').replace(/\[[^\]]*\]/g, '');
    const seg = cleaned.split('.').filter(Boolean).pop();
    return seg ? humanizeFieldKey(seg) : '';
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
            const head = itemVar ? `‹Loop item · ${itemVar}›` : '‹Loop item›';
            return path ? `${head}.${path}` : head;
        })
        .replace(/\btrigger(?:\.([A-Za-z0-9_.[\]]+))?/g, (_m, path?: string) => (path ? `‹Trigger›.${path}` : '‹Trigger›'));
}

/** `steps.g1.output.results[*].subject` → `subject`. */
function lastPathSegment(path: unknown): string {
    const cleaned = String(path || '').replace(/\[(?:\*|\d+)\]/g, '');
    return cleaned.split('.').filter(Boolean).pop() || '';
}

function describeRow(row: ConditionRow): string | null {
    const field = row.field as { kind?: string; path?: string } | null;
    const path = field?.kind === 'ref' ? field.path : '';
    if (!path) return null;
    const name = humanizeFieldKey(lastPathSegment(path));
    const op = labelFor(row.op, 'unknown');
    if (isUnaryOp(row.op)) return `${name} ${op}`;
    const v = row.value as { kind?: string; path?: string; value?: unknown } | null;
    if (v?.kind === 'ref' && v.path) return `${name} ${op} ${humanizeFieldKey(lastPathSegment(v.path))}`;
    const raw = v?.kind === 'literal' ? v.value : v?.value;
    if (raw === '' || raw == null) return `${name} ${op}`;
    return typeof raw === 'string' ? `${name} ${op} “${raw}”` : `${name} ${op} ${raw}`;
}

/**
 * A rule expression as a sentence: `contains(item.subject, "isv")` →
 * Subject contains “isv”. What the clickable model cannot parse falls back
 * to `humanizeExpression`.
 */
export function describeRuleExpr(expr: unknown, stepLabelById: Map<string, string> | null = null): string {
    const src = String(expr || '').trim();
    if (!src) return '';
    const parsed = parseExprToRows(src);
    if (!parsed?.rows?.length) return humanizeExpression(src, stepLabelById);
    const joiner = parsed.join === '||' ? ' or ' : ' and ';
    const parts = parsed.rows.map(describeRow).filter(Boolean);
    return parts.length ? parts.join(joiner) : humanizeExpression(src, stepLabelById);
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

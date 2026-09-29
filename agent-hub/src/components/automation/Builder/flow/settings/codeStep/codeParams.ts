// Pure readings for the code step's screens: parameters as a form schema, the
// split between declared and other inputs, test values, host names and the
// state of the checks. React-free so every rule here has a plain test.

import type { CodeAnalysis, CodeFinding, CodeParam } from '../../../../../../api/queries/automation/codeStep';
import { walkPath } from '../../../../../../utils/bindingHelpers';

type Obj = Record<string, unknown>;
export type Binding = { kind: string; value?: unknown; path?: string } & Obj;
export type InputsMap = Record<string, Binding>;

export interface ParamSchemaProp {
    type: string;
    title: string;
    description?: string;
    format?: string;
    enum?: Array<string | number>;
    default?: unknown;
    items?: { type: string };
    'x-primary': true;
}

/**
 * The declared parameters in the shape ToolInputForm's schema mode reads.
 * Every declared parameter is marked primary: the author listed it on
 * purpose, so none of them hides behind "more options".
 */
export function paramsToSchema(params: CodeParam[]): { properties: Record<string, ParamSchemaProp>; required: string[] } {
    const properties: Record<string, ParamSchemaProp> = {};
    for (const p of params) {
        const prop: ParamSchemaProp = { type: p.type, title: p.label, 'x-primary': true };
        if (p.description) prop.description = p.description;
        if (p.format) prop.format = p.format;
        if (p.enum?.length) prop.enum = p.enum;
        if (p.default !== undefined) prop.default = p.default;
        if (p.items) prop.items = p.items;
        properties[p.name] = prop;
    }
    return { properties, required: params.filter(p => p.required).map(p => p.name) };
}

/** Declared inputs and the rest ("Other inputs"), so each gets its own editor. */
export function splitInputs(inputs: InputsMap | null | undefined, params: CodeParam[]): { declared: InputsMap; others: InputsMap } {
    const names = new Set(params.map(p => p.name));
    const declared: InputsMap = {};
    const others: InputsMap = {};
    for (const [k, v] of Object.entries(inputs || {})) (names.has(k) ? declared : others)[k] = v;
    return { declared, others };
}

/** Upstream field NAMES and kinds for the assistant: never a value. */
export function upstreamFieldsFrom(groups: unknown, limit = 80): Array<{ path: string; label: string; type: string }> {
    const out: Array<{ path: string; label: string; type: string }> = [];
    const visit = (fields: unknown, groupLabel: string, depth: number) => {
        if (!Array.isArray(fields) || depth > 2) return;
        for (const f of fields as Obj[]) {
            if (out.length >= limit) return;
            if (typeof f?.path !== 'string') continue;
            out.push({ path: f.path, label: `${groupLabel} › ${String(f.key ?? f.path)}`, type: kindOf(f.sample) });
            visit(f.children, groupLabel, depth + 1);
        }
    };
    for (const g of (Array.isArray(groups) ? groups : []) as Obj[]) visit(g?.fields, String(g?.label || ''), 0);
    return out;
}

function kindOf(sample: unknown): string {
    if (Array.isArray(sample)) return 'array';
    if (sample === null || sample === undefined) return 'unknown';
    return typeof sample === 'object' ? 'object' : typeof sample;
}

const asText = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
};

function coerce(p: CodeParam | undefined, raw: string): unknown {
    const text = raw.trim();
    if (!p) return raw;
    if (p.type === 'number' || p.type === 'integer') return Number.isFinite(Number(text)) ? Number(text) : raw;
    if (p.type === 'boolean') return text === 'true' ? true : text === 'false' ? false : raw;
    if (p.type === 'object' || p.type === 'array') {
        try { return JSON.parse(text); } catch { return raw; }
    }
    return raw;
}

/** "gmail_send" → "Gmail: send", the way the capability line names a connected app. */
export function toolLabel(name: string): string {
    const [app, ...rest] = String(name).split('_');
    const App = app ? app.charAt(0).toUpperCase() + app.slice(1) : name;
    return rest.length ? `${App}: ${rest.join(' ')}` : App;
}

export const isApproved = (a: CodeAnalysis | null | undefined, f: CodeFinding): boolean =>
    !!a && a.approvals.some(ap => ap.ruleId === f.ruleId && (!ap.codeHash || ap.codeHash === a.hash));

export interface ChecksState {
    blocks: CodeFinding[];
    toReview: CodeFinding[];
    approved: CodeFinding[];
    infos: CodeFinding[];
    /** Tools the code calls that the step is not allowed to use. */
    toolsNotAllowed: string[];
}

export function checksState(a: CodeAnalysis | null | undefined, allowedTools: string[]): ChecksState {
    const findings = a?.findings || [];
    const allowed = new Set(allowedTools);
    return {
        blocks: findings.filter(f => f.severity === 'block'),
        toReview: findings.filter(f => f.severity === 'warn' && !isApproved(a, f)),
        approved: findings.filter(f => f.severity === 'warn' && isApproved(a, f)),
        infos: findings.filter(f => f.severity === 'info'),
        toolsNotAllowed: (a?.capabilities.tools || []).filter(t => !allowed.has(t)),
    };
}

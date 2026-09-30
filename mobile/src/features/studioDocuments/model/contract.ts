/**
 * The document contract's pure rules, ported from the server so the phone can
 * answer two questions without a round trip:
 *
 *   - would the server accept this contract? (`contractProblem`, the checks of
 *     core/documents/documentContract.js normalizeContract, same wording)
 *   - does this section apply to these customer values? (`evaluateCondition`,
 *     with `lookup` from core/documents/documentTemplate.js)
 *
 * The server stays the authority: it re-checks on save and on /validate.
 * contract.lockstep.test.ts runs both implementations on the same fixtures.
 */

import { OPERATORS, PARAM_TYPES, type Condition, type SectionState } from './types';

type Loose = Record<string, unknown>;

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

/** A dotted parameter path the server accepts (documentContract.safePath). */
export function safePath(path: unknown): boolean {
    return (
        typeof path === 'string' &&
        /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(path) &&
        path.split('.').every((p) => p !== '' && !FORBIDDEN.has(p))
    );
}

/** documentTemplate.lookup over one scope: a dotted path into nested values. */
export function lookup(path: string, scope: unknown): { found: boolean; value: unknown } {
    const parts = String(path).split('.').filter(Boolean);
    if (parts.some((p) => FORBIDDEN.has(p))) return { found: false, value: undefined };
    let cur: unknown = scope;
    for (const part of parts) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined };
        if (!Object.prototype.hasOwnProperty.call(cur, part)) return { found: false, value: undefined };
        cur = (cur as Loose)[part];
    }
    return cur === undefined ? { found: false, value: undefined } : { found: true, value: cur };
}

/**
 * Stored customer values are keyed by the parameter's dotted key
 * (`customer.name`); the server nests them before it evaluates
 * (documentContract.setPath). Unsafe keys are skipped rather than thrown.
 */
export function nestValues(flat: Loose): Loose {
    const out: Loose = {};
    for (const [key, value] of Object.entries(flat)) {
        if (!safePath(key)) continue;
        const parts = key.split('.');
        let cur = out;
        for (const part of parts.slice(0, -1)) {
            const next = cur[part];
            if (!next || typeof next !== 'object' || Array.isArray(next)) cur[part] = {};
            cur = cur[part] as Loose;
        }
        cur[parts[parts.length - 1] as string] = value;
    }
    return out;
}

export interface Evaluation {
    state: SectionState;
    reason: string;
}

function combine(rule: { all: Condition[] } | { any: Condition[] }, values: Loose): Evaluation {
    const all = 'all' in rule;
    const results = (all ? rule.all : rule.any).map((r) => evaluateCondition(r, values));
    const has = (s: SectionState) => results.some((r) => r.state === s);
    let state: SectionState;
    if (all) state = has('excluded') ? 'excluded' : has('unresolved') ? 'unresolved' : 'included';
    else state = has('included') ? 'included' : has('unresolved') ? 'unresolved' : 'excluded';
    return { state, reason: results.map((r) => r.reason).join(all ? ' AND ' : ' OR ') };
}

function compare(operator: string, value: unknown, expected: unknown): boolean | null {
    switch (operator) {
        case 'is_set':
            return value !== '';
        case 'equals':
            return value === expected;
        case 'not_equals':
            return value !== expected;
        case 'contains':
            return (typeof value === 'string' || Array.isArray(value)) && value.includes(expected as never);
        case 'greater_than':
        case 'less_than':
            if (typeof value !== 'number' || typeof expected !== 'number') return null;
            return operator === 'greater_than' ? value > expected : value < expected;
        default:
            return null;
    }
}

/** Does a section with this rule apply to these (nested) values? */
export function evaluateCondition(rule: Condition | null | undefined, values: Loose): Evaluation {
    if (!rule) return { state: 'included', reason: 'Always included' };
    if ('all' in rule || 'any' in rule) return combine(rule, values);
    const { found, value } = lookup(rule.parameter, values);
    if (!found || value === null) return { state: 'unresolved', reason: `Needs input: ${rule.parameter}` };
    const yes = compare(rule.operator, value, rule.value);
    if (yes === null) {
        const numeric = rule.operator === 'greater_than' || rule.operator === 'less_than';
        return { state: 'unresolved', reason: numeric ? `Needs a number: ${rule.parameter}` : 'Invalid rule' };
    }
    const shown = `${rule.parameter}: ${rule.operator.replaceAll('_', ' ')} ${rule.value === undefined || rule.value === null ? '' : String(rule.value)}`;
    return { state: yes ? 'included' : 'excluded', reason: shown.trim() };
}

function groupProblem(r: Loose, depth: number): string | null {
    const children = (r.all || r.any) as unknown;
    if (!Array.isArray(children) || !children.length || children.length > 50 || (r.all && r.any)) {
        return 'Use a nonempty all or any rule group.';
    }
    for (const child of children) {
        if (!child || typeof child !== 'object') return 'Invalid condition in rule group.';
        const problem = conditionProblem(child, depth + 1);
        if (problem) return problem;
    }
    return null;
}

function conditionProblem(rule: unknown, depth: number): string | null {
    if (!rule) return null;
    if (depth > 6) return 'Section rules may nest at most six levels.';
    const r = rule as Loose;
    if (r.all || r.any) return groupProblem(r, depth);
    return safePath(r.parameter) && (OPERATORS as readonly unknown[]).includes(r.operator) ? null : 'Invalid section rule.';
}

function fieldsProblem(p: Loose): string | null {
    if (p.fields && (!Array.isArray(p.fields) || p.fields.length > 100)) return 'Invalid list fields.';
    const options = p.options;
    if (p.type === 'choice' && (!Array.isArray(options) || !options.length || options.length > 100 || options.some((o) => typeof o !== 'string'))) {
        return 'Choices need a list of options.';
    }
    if (Array.isArray(p.fields) && new Set(p.fields.map((f) => (f as Loose | null)?.key)).size !== p.fields.length) {
        return 'List field keys must be unique.';
    }
    return null;
}

function parameterProblem(p: unknown, keys: Set<string>, nested: boolean): string | null {
    const param = p as Loose | null;
    if (!param || !safePath(param.key) || !(PARAM_TYPES as readonly unknown[]).includes(param.type)) {
        return 'Each parameter needs a safe key and a supported type.';
    }
    const key = param.key as string;
    if (!nested && keys.has(key)) return `Duplicate parameter: ${key}`;
    if (!nested) keys.add(key);
    if (param.type === 'list' && nested) return 'Nested list fields are not supported.';
    const own = fieldsProblem(param);
    if (own) return own;
    if (param.type !== 'list') return null;
    for (const f of (param.fields as unknown[] | undefined) ?? []) {
        const problem = parameterProblem(f, keys, true);
        if (problem) return problem;
    }
    return null;
}

function sectionsProblem(sections: unknown[]): string | null {
    const ids = new Set<string>();
    for (const s of sections) {
        const section = s as Loose | null;
        const id = section?.id;
        if (!section || typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || ids.has(id)) {
            return 'Section IDs must be unique letters, numbers, underscores or hyphens.';
        }
        ids.add(id);
        const problem = conditionProblem(section.condition, 0);
        if (problem) return problem;
    }
    return null;
}

/** The message the server's normalizeContract would refuse this contract with, or null. */
export function contractProblem(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Expected a document contract.';
    const contract = raw as Loose;
    const parameters = contract.parameters ?? [];
    const sections = contract.sections ?? [];
    if (!Array.isArray(parameters) || parameters.length > 200 || !Array.isArray(sections) || sections.length > 100) {
        return 'Maximum 200 parameters and 100 sections.';
    }
    const keys = new Set<string>();
    for (const p of parameters) {
        const problem = parameterProblem(p, keys, false);
        if (problem) return problem;
    }
    return sectionsProblem(sections);
}

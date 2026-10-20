// The test-case form, apart from React: the draft the editor holds, the body
// it sends, the checks it runs before sending, and the path suggestions. Every
// rule here has a plain test (testCaseForm.test.ts).
//
// A draft holds TEXT (what the boxes show); the body holds values. A value box
// reads "JSON or text": 3, true, [1,2] and {"a":1} are those values, anything
// else is the text as typed, and a text that would read as JSON ("3") is
// written with quotes ("\"3\"").

import { parsePath } from '@shared/expr/path.mjs';
import {
    ASSERTION_OPS,
    type Assertion,
    type AssertionOp,
    type Expectation,
    type TestCase,
    type TestCaseBody,
} from '../../../../../../api/queries/automation/testCases';
import type { CodeParam } from '../../../../../../api/queries/automation/codeStep';
import { inputsFromValues, tryValuesFrom } from './CodeTryPanel';

export { ASSERTION_OPS };
export type { AssertionOp };

export const TYPE_NAMES = ['string', 'number', 'boolean', 'object', 'array', 'null'] as const;
export type TypeName = (typeof TYPE_NAMES)[number];
export const COUNT_COMPARISONS = ['eq', 'gte', 'lte'] as const;
export type CountComparison = (typeof COUNT_COMPARISONS)[number];

export const NAME_MAX = 80;

export interface AssertionDraft {
    id: string;
    op: AssertionOp;
    path: string;
    /** equals, not_equals, contains: JSON or text. */
    text: string;
    /** has_key. */
    key: string;
    /** type_is. */
    type: TypeName;
    /** count_is. */
    cmp: CountComparison;
    n: string;
}

export interface CaseDraft {
    name: string;
    expect: Expectation;
    inputKind: 'typed' | 'run';
    /** One text per input name, for typed values. */
    values: Record<string, string>;
    /** The run to take the input from, for a recorded input. */
    runId: string;
    attempts: number | null;
    assertions: AssertionDraft[];
}

export function newAssertion(op: AssertionOp = 'equals', id: string = newAssertionId()): AssertionDraft {
    return { id, op, path: '', text: '', key: '', type: 'string', cmp: 'eq', n: '1' };
}

let counter = 0;
/** Unique within a form; 1 to 40 characters as the server wants. */
export function newAssertionId(): string {
    counter += 1;
    return `a${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── Values as text ────────────────────────────────────────────────────────

/** "JSON or text": valid JSON is that value, anything else is the text. */
export function valueFromText(text: string): unknown {
    const raw = text.trim();
    if (!raw) return '';
    try { return JSON.parse(raw); } catch { return raw; }
}

/** The text that reads back as `value` through valueFromText. */
export function textFromValue(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') {
        const looksLikeJson = value.trim() !== value || value === '' || (() => { try { JSON.parse(value); return true; } catch { return false; } })();
        return looksLikeJson ? JSON.stringify(value) : value;
    }
    return JSON.stringify(value);
}

// ── Paths ─────────────────────────────────────────────────────────────────

/** Is `path` one the shared grammar reads? '' (the whole result) is. Same rule as the server's check. */
export function isReadablePath(path: string): boolean {
    let p = path.trim();
    if (p === '' || p === '$') return true;
    if (p.startsWith('$.')) p = p.slice(2);
    else if (p.startsWith('$[')) p = p.slice(1);
    return parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`) != null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Paths worth offering for a result: its fields, two levels down, and the
 * first element of a list. Bounded, so a big result never makes a long menu.
 */
export function pathChoices(result: unknown, limit = 40): string[] {
    const out: string[] = [];
    const visit = (value: unknown, prefix: string, depth: number) => {
        if (out.length >= limit || depth > 2) return;
        if (isRecord(value)) {
            for (const key of Object.keys(value)) {
                if (out.length >= limit) return;
                const path = prefix ? `${prefix}.${key}` : key;
                if (!SIMPLE_KEY.test(key)) continue;
                out.push(path);
                visit(value[key], path, depth + 1);
            }
        } else if (Array.isArray(value) && value.length > 0 && prefix) {
            const path = `${prefix}[0]`;
            out.push(path);
            visit(value[0], path, depth + 1);
        }
    };
    visit(result, '', 0);
    return out;
}

// ── Assertions ────────────────────────────────────────────────────────────

export function assertionToBody(d: AssertionDraft): Assertion {
    const base = { id: d.id, op: d.op, path: d.path.trim() };
    switch (d.op) {
        case 'equals':
        case 'not_equals':
        case 'contains':
            return { ...base, value: valueFromText(d.text) };
        case 'has_key':
            return { ...base, value: d.key.trim() };
        case 'type_is':
            return { ...base, value: d.type };
        case 'count_is':
            return { ...base, value: { cmp: d.cmp, n: Number(d.n) } };
    }
}

export function assertionFromBody(a: Assertion): AssertionDraft {
    const d = newAssertion(a.op, a.id);
    d.path = a.path || '';
    if (a.op === 'equals' || a.op === 'not_equals' || a.op === 'contains') d.text = textFromValue(a.value);
    else if (a.op === 'has_key') d.key = typeof a.value === 'string' ? a.value : '';
    else if (a.op === 'type_is') d.type = TYPE_NAMES.includes(a.value as TypeName) ? a.value as TypeName : 'string';
    else if (a.op === 'count_is' && isRecord(a.value)) {
        d.cmp = COUNT_COMPARISONS.includes(a.value.cmp as CountComparison) ? a.value.cmp as CountComparison : 'eq';
        d.n = typeof a.value.n === 'number' ? String(a.value.n) : '1';
    }
    return d;
}

export type AssertionProblem = { path?: 'invalid'; value?: 'needed' | 'bad_number' };

/** What is wrong with one assertion row, per field. */
export function assertionProblems(d: AssertionDraft): AssertionProblem {
    const problems: AssertionProblem = {};
    if (!isReadablePath(d.path)) problems.path = 'invalid';
    if ((d.op === 'equals' || d.op === 'not_equals' || d.op === 'contains') && !d.text.trim()) problems.value = 'needed';
    if (d.op === 'has_key' && !d.key.trim()) problems.value = 'needed';
    if (d.op === 'count_is' && !/^\d{1,9}$/.test(d.n.trim())) problems.value = 'bad_number';
    return problems;
}

// ── The whole form ────────────────────────────────────────────────────────

export interface CaseProblems {
    name: 'needed' | 'too_long' | null;
    input: 'run_needed' | null;
    tooManyAssertions: boolean;
    assertions: Record<string, AssertionProblem>;
}

export function caseProblems(d: CaseDraft, maxAssertions = 0, keepInput = false): CaseProblems {
    const name = d.name.trim();
    const assertions: Record<string, AssertionProblem> = {};
    for (const a of d.assertions) {
        const p = assertionProblems(a);
        if (p.path || p.value) assertions[a.id] = p;
    }
    return {
        name: !name ? 'needed' : name.length > NAME_MAX ? 'too_long' : null,
        input: d.inputKind === 'run' && !keepInput && !d.runId.trim() ? 'run_needed' : null,
        tooManyAssertions: maxAssertions > 0 && d.assertions.length > maxAssertions,
        assertions,
    };
}

export const isCaseValid = (p: CaseProblems): boolean =>
    !p.name && !p.input && !p.tooManyAssertions && Object.keys(p.assertions).length === 0;

/**
 * The body to send. `keepInput` leaves the input out, so a case whose recorded
 * input is unchanged is not captured again.
 */
export function bodyFromDraft(d: CaseDraft, keepInput = false): TestCaseBody {
    const body: TestCaseBody = {
        name: d.name.trim(),
        expect: d.expect,
        assertions: d.assertions.map(assertionToBody),
    };
    if (keepInput) return body;
    body.input = d.inputKind === 'run'
        ? { kind: 'run', runId: d.runId.trim(), ...(d.attempts != null ? { attempts: d.attempts } : {}) }
        : { kind: 'typed', values: inputsFromValues(d.values) };
    return body;
}

/** A starting value per input name: the parameter's default, never a value from a run. */
export function defaultValues(params: CodeParam[], otherNames: string[] = []): Record<string, string> {
    return tryValuesFrom(params, {}, otherNames);
}

const asText = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** The text boxes of a saved typed input. */
export function valuesToText(values: Record<string, unknown> | null | undefined, names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of names) out[n] = '';
    for (const [k, v] of Object.entries(values || {})) out[k] = asText(v);
    return out;
}

export interface DraftSeed {
    params: CodeParam[];
    otherNames?: string[];
    /** The case being edited. */
    existing?: TestCase | null;
    /** The saved typed values of that case. */
    existingValues?: Record<string, unknown> | null;
    /** A run to take the input from (the "Save as test case" start). */
    run?: { runId: string; attempts?: number | null } | null;
}

export function draftFrom(seed: DraftSeed): CaseDraft {
    const names = [...seed.params.map((p) => p.name), ...(seed.otherNames || []).filter((n) => !seed.params.some((p) => p.name === n))];
    const base: CaseDraft = {
        name: '', expect: 'success', inputKind: 'typed', values: defaultValues(seed.params, seed.otherNames),
        runId: '', attempts: null, assertions: [],
    };
    const c = seed.existing;
    if (c) {
        base.name = c.name;
        base.expect = c.expect;
        base.assertions = c.assertions.map(assertionFromBody);
        if (c.input.kind === 'run') {
            base.inputKind = 'run';
            // A run that is gone cannot be captured again: the person picks another.
            base.runId = c.input.available ? c.input.runId || '' : '';
        } else {
            base.values = valuesToText(seed.existingValues ?? c.input.values, names);
        }
        return base;
    }
    if (seed.run) {
        base.inputKind = 'run';
        base.runId = seed.run.runId;
        base.attempts = seed.run.attempts ?? null;
    }
    return base;
}

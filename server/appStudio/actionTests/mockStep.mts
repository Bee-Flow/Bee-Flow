/**
 * A fixed answer for an AI step in a test run (app_run_action / app_run_tests `mock`).
 *
 * The mock is the MODEL'S ANSWER, not the step's result: the step's own pure post-processing
 * still runs on it (schema coercion, row slicing, markdown conversion), so a schema or prompt
 * change makes a test fail exactly where a real run would differ.
 *
 *   ai_generate (text)        string or { text }       → { text, citations: [] } (+ markdownToHtml)
 *   ai_generate (structured)  object                   → coerceRowToFields(answer, the step's schema)
 *   ai_extract                { rows }, array, object  → { rows, count, written: 0, incomplete, ... }
 *   kb_query                  array or { results }     → { results, count }
 *   dataset_query             anything                 → as is
 *   any                       { "$error": text, "$code"?, "$retryable"? } → the step fails
 *
 * A mocked step never writes (writeTo is not applied), never reads files, a knowledge base or a
 * model, and never reaches the executor, so it costs no AI budget and no run budget.
 */

import { createRequire } from 'node:module';
import { stepPaths } from '../sequenceWalk.mts';
import type { StepPath, StepResult } from '../sequenceWalk.mts';
import { MOCKABLE_KINDS } from '../mcpRunActionPolicy.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type SchemaField = { name: string; required?: boolean };

export type MockHelpers = {
    normalizeSchemaFields: (fields: unknown) => SchemaField[];
    coerceRowToFields: (row: unknown, fields: SchemaField[]) => Obj;
    markdownToHtml: (md: string) => string;
    maxExtractRows: number;
};

export const MAX_MOCKS = 50;
export const MAX_MOCK_BYTES = 64 * 1024;
const MAX_MOCK_ERROR_CHARS = 300;
const MAX_LISTED_PATHS = 30;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The real coercion helpers (aiRuntime), loaded on first use. */
export function defaultMockHelpers(): MockHelpers {
    const ai = nodeRequire('../aiRuntime.js') as {
        normalizeSchemaFields: MockHelpers['normalizeSchemaFields']; coerceRowToFields: MockHelpers['coerceRowToFields']; MAX_EXTRACT_ROWS: number;
    };
    return {
        normalizeSchemaFields: ai.normalizeSchemaFields,
        coerceRowToFields: ai.coerceRowToFields,
        markdownToHtml: (md) => (nodeRequire('../../services/email/send.js') as { markdownToHtml: (m: string) => string }).markdownToHtml(md),
        maxExtractRows: ai.MAX_EXTRACT_ROWS,
    };
}

function mockedError(answer: Obj): StepResult {
    const text = typeof answer.$error === 'string' && answer.$error.trim() ? answer.$error : 'Mocked failure';
    return {
        ok: false, error: text.slice(0, MAX_MOCK_ERROR_CHARS),
        ...(typeof answer.$code === 'string' ? { code: answer.$code.slice(0, 60) } : {}),
        ...(typeof answer.$retryable === 'boolean' ? { retryable: answer.$retryable } : {}),
    };
}

const writeNote = (step: Obj): string[] => (step.writeTo !== undefined ? ['mocked: writeTo not applied'] : []);

function mockGenerate(step: Obj, answer: unknown, prompt: string | undefined, h: MockHelpers): StepResult {
    if (typeof prompt === 'string' && !prompt.trim()) return { ok: false, error: 'The prompt is empty' };
    if (step.output === 'structured') {
        const fields = h.normalizeSchemaFields(step.schema);
        if (!fields.length) return { ok: false, error: 'Structured output needs at least one field' };
        if (!isObject(answer)) return { ok: false, error: 'The mock of a structured ai_generate must be an object with the schema fields' };
        return { ok: true, result: h.coerceRowToFields(answer, fields), notes: writeNote(step) };
    }
    const raw = isObject(answer) && typeof answer.text === 'string' ? answer.text : answer;
    if (typeof raw !== 'string') return { ok: false, error: 'The mock of a text ai_generate must be a string or { text }' };
    const text = step.markdownToHtml === true ? h.markdownToHtml(raw) : raw;
    return { ok: true, result: { text, citations: [] }, notes: writeNote(step) };
}

function mockExtract(step: Obj, answer: unknown, h: MockHelpers): StepResult {
    const fields = h.normalizeSchemaFields(step.schema);
    if (!fields.length) return { ok: false, error: 'No output fields are configured for extraction' };
    let list: unknown[];
    if (Array.isArray(answer)) list = answer;
    else if (isObject(answer) && Array.isArray(answer.rows)) list = answer.rows;
    else if (isObject(answer)) list = [answer];
    else return { ok: false, error: 'The mock of an ai_extract must be { rows: [...] }, a list of rows, or one row object' };
    const rows = list.slice(0, h.maxExtractRows).map((r) => h.coerceRowToFields(r, fields));
    const required = fields.filter((f) => f.required).map((f) => f.name);
    const incomplete = required.length
        ? rows.filter((r) => required.some((n) => r[n] === null || r[n] === undefined || r[n] === '')).length
        : 0;
    const summary = step.resultDetail === 'summary';
    return {
        ok: true,
        result: { rows: summary ? [] : rows, count: rows.length, written: 0, incomplete, unmatched: [], unmatchedCount: 0, model: 'mock', tier: 'mock' },
        notes: writeNote(step),
    };
}

function mockKb(answer: unknown): StepResult {
    let results: unknown[];
    if (Array.isArray(answer)) results = answer;
    else if (isObject(answer) && Array.isArray(answer.results)) results = answer.results;
    else return { ok: false, error: 'The mock of a kb_query must be a list of results or { results: [...] }' };
    return { ok: true, result: { results, count: results.length } };
}

/**
 * The step result a mocked answer gives. `prompt` is the step's interpolated prompt
 * (ai_generate), so an empty prompt fails the way the real step does.
 */
export function mockStepResult(step: Obj, answer: unknown, opts: { prompt?: string; helpers?: MockHelpers } = {}): StepResult {
    if (isObject(answer) && Object.hasOwn(answer, '$error')) return mockedError(answer);
    const h = opts.helpers ?? defaultMockHelpers();
    switch (step.kind) {
        case 'ai_generate': return mockGenerate(step, answer, opts.prompt, h);
        case 'ai_extract': return mockExtract(step, answer, h);
        case 'kb_query': return mockKb(answer);
        case 'dataset_query': return { ok: true, result: answer ?? null };
        default: return { ok: false, error: `${String(step.kind)} cannot be mocked` };
    }
}

/** The walker paths of `action` a mock may name (AI and read steps). */
export function mockablePaths(action: unknown): StepPath[] {
    return stepPaths(action).filter((p) => MOCKABLE_KINDS.includes(p.kind));
}

function listPaths(paths: StepPath[]): string {
    const head = paths.slice(0, MAX_LISTED_PATHS).map((p) => `${p.path} (${p.kind})`).join(', ');
    return paths.length > MAX_LISTED_PATHS ? `${head}, … ${paths.length - MAX_LISTED_PATHS} more` : head || '(none: this action has no AI or read step)';
}

/** A `mock` argument checked against the action: every key a mockable walker path. */
export function checkMock(raw: unknown, action: unknown): { mock: Obj } | { error: string; _fixHint: string } {
    if (raw === undefined || raw === null) return { mock: {} };
    const paths = mockablePaths(action);
    const hint = `Mockable steps of this action: ${listPaths(paths)}.`;
    if (!isObject(raw)) return { error: 'mock must be an object { "<step path>": <answer> }.', _fixHint: hint };
    const keys = Object.keys(raw);
    if (keys.length > MAX_MOCKS) return { error: `mock names ${keys.length} steps; at most ${MAX_MOCKS}.`, _fixHint: hint };
    if ((JSON.stringify(raw) ?? '').length > MAX_MOCK_BYTES) return { error: `mock is larger than ${MAX_MOCK_BYTES / 1024} KB.`, _fixHint: hint };
    const known = new Set(paths.map((p) => p.path));
    const bad = keys.filter((k) => !known.has(k));
    if (bad.length) {
        return { error: `mock names ${bad.slice(0, 5).map((k) => `"${k.slice(0, 80)}"`).join(', ')}, not an AI or read step of this action.`, _fixHint: hint };
    }
    return { mock: { ...raw } };
}

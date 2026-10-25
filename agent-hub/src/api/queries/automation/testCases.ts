// Test cases on a code step or a custom node: the ONLY place that knows the
// wire contract of
//   GET    /api/automation/:id/test-cases?stepId=
//   GET    /api/automation/:id/test-cases/:caseId
//   POST   /api/automation/:id/test-cases
//   PUT    /api/automation/:id/test-cases/:caseId
//   DELETE /api/automation/:id/test-cases/:caseId
//   POST   /api/automation/:id/test-cases/run
// Every reader is defensive: a field the server leaves out reads as nothing,
// never as a crash. The values of a recorded run are never in a list row; they
// come only from the one-case read.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, ApiError } from '../../client';
import { parseCodeTest, type CodeTestCall } from './codeStep';

export type AssertionOp = 'equals' | 'not_equals' | 'contains' | 'has_key' | 'type_is' | 'count_is';
export const ASSERTION_OPS: AssertionOp[] = ['equals', 'not_equals', 'contains', 'has_key', 'type_is', 'count_is'];

export interface Assertion {
    id: string;
    op: AssertionOp;
    /** A path into the result; '' is the whole result. */
    path: string;
    value?: unknown;
}

type AssertionCode =
    | 'ok' | 'path_missing' | 'not_equal' | 'equal' | 'not_contained' | 'key_missing' | 'wrong_type' | 'wrong_count' | 'not_countable';

export interface AssertionResult {
    id: string;
    ok: boolean;
    code: AssertionCode | string;
    params: { path: string; expected?: string; actual?: string };
}

export type TestStatus = 'pass' | 'fail' | 'error' | 'unusable';
export type Expectation = 'success' | 'error';

type TestCaseInputInfo =
    | { kind: 'typed'; values: Record<string, unknown> | null }
    | { kind: 'run'; runId: string | null; available: boolean };

export interface TestCase {
    id: string;
    stepId: string;
    name: string;
    expect: Expectation;
    assertions: Assertion[];
    input: TestCaseInputInfo;
    lastStatus: TestStatus | null;
    lastRunAt: string | null;
}

export interface TestCaseList {
    testCases: TestCase[];
    limits: { perStep: number; assertions: number };
}

/** What a case is created or changed with. A run input is captured by the server. */
type TestCaseInputBody =
    | { kind: 'typed'; values: Record<string, unknown> }
    | { kind: 'run'; runId: string; attempts?: number };

export interface TestCaseBody {
    name?: string;
    expect?: Expectation;
    assertions?: Assertion[];
    input?: TestCaseInputBody;
}

export interface TestCaseDetail {
    testCase: TestCase | null;
    input: { kind: 'typed' | 'run'; available: boolean; values: Record<string, unknown> | null; runId: string | null };
}

type TestReason =
    | 'fixture_expired' | 'code_syntax_error' | 'code_blocked' | 'code_param_invalid' | 'sandbox_missing';

export interface TestRunResult {
    caseId: string;
    name: string;
    status: TestStatus;
    reason: TestReason | string | null;
    expectation: { expected: Expectation; got: Expectation | null };
    assertions: AssertionResult[];
    result: unknown;
    hasResult: boolean;
    error: string | null;
    logs: string[];
    calls: CodeTestCall[];
    durationMs: number | null;
}

export interface TestRunResponse {
    stepId: string;
    results: TestRunResult[];
    summary: { passed: number; failed: number; errored: number; unusable: number };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const STATUSES: TestStatus[] = ['pass', 'fail', 'error', 'unusable'];
const status = (v: unknown): TestStatus | null => (STATUSES.includes(v as TestStatus) ? v as TestStatus : null);
const expectation = (v: unknown): Expectation => (v === 'error' ? 'error' : 'success');

function parseAssertion(raw: unknown): Assertion | null {
    const r = obj(raw);
    const id = str(r.id);
    if (!id || !ASSERTION_OPS.includes(r.op as AssertionOp)) return null;
    const a: Assertion = { id, op: r.op as AssertionOp, path: typeof r.path === 'string' ? r.path : '' };
    if (r.value !== undefined) a.value = r.value;
    return a;
}

function parseAssertionResult(raw: unknown): AssertionResult | null {
    const r = obj(raw);
    const id = str(r.id);
    if (!id) return null;
    const p = obj(r.params);
    return {
        id,
        ok: r.ok === true,
        code: str(r.code) || (r.ok === true ? 'ok' : 'not_equal'),
        params: {
            path: typeof p.path === 'string' ? p.path : '',
            ...(typeof p.expected === 'string' ? { expected: p.expected } : {}),
            ...(typeof p.actual === 'string' ? { actual: p.actual } : {}),
        },
    };
}

function parseInput(raw: unknown): TestCaseInputInfo {
    const r = obj(raw);
    if (r.kind === 'run') return { kind: 'run', runId: str(r.runId), available: r.available === true };
    return { kind: 'typed', values: r.values && typeof r.values === 'object' && !Array.isArray(r.values) ? r.values as Obj : null };
}

export function parseTestCase(raw: unknown): TestCase | null {
    const r = obj(raw);
    const id = str(r.id);
    if (!id) return null;
    return {
        id,
        stepId: str(r.stepId) || '',
        name: str(r.name) || id,
        expect: expectation(r.expect),
        assertions: (Array.isArray(r.assertions) ? r.assertions : []).map(parseAssertion).filter((a): a is Assertion => !!a),
        input: parseInput(r.input),
        lastStatus: status(r.lastStatus),
        lastRunAt: str(r.lastRunAt),
    };
}

export function parseTestCaseList(body: unknown): TestCaseList {
    const b = obj(body);
    const limits = obj(b.limits);
    return {
        testCases: (Array.isArray(b.testCases) ? b.testCases : []).map(parseTestCase).filter((c): c is TestCase => !!c),
        limits: { perStep: count(limits.perStep), assertions: count(limits.assertions) },
    };
}

export function parseTestCaseDetail(body: unknown): TestCaseDetail {
    const b = obj(body);
    const i = obj(b.input);
    return {
        testCase: parseTestCase(b.testCase),
        input: {
            kind: i.kind === 'run' ? 'run' : 'typed',
            available: i.available !== false,
            values: i.values && typeof i.values === 'object' && !Array.isArray(i.values) ? i.values as Obj : null,
            runId: str(i.runId),
        },
    };
}

function parseResult(raw: unknown): TestRunResult | null {
    const r = obj(raw);
    const caseId = str(r.caseId);
    if (!caseId) return null;
    const exp = obj(r.expectation);
    // The sandbox fields (result, error, logs, calls, durationMs) read like a "Try it" answer.
    const run = parseCodeTest({ result: r.result, error: r.error, logs: r.logs, calls: r.calls, durationMs: r.durationMs });
    return {
        caseId,
        name: str(r.name) || caseId,
        status: status(r.status) || 'error',
        reason: str(r.reason),
        expectation: { expected: expectation(exp.expected), got: exp.got === 'success' || exp.got === 'error' ? exp.got : null },
        assertions: (Array.isArray(r.assertions) ? r.assertions : []).map(parseAssertionResult).filter((a): a is AssertionResult => !!a),
        result: run.result,
        hasResult: 'result' in r,
        error: run.error,
        logs: run.logs,
        calls: run.calls,
        durationMs: run.durationMs,
    };
}

export function parseTestRun(body: unknown): TestRunResponse {
    const b = obj(body);
    const s = obj(b.summary);
    return {
        stepId: str(b.stepId) || '',
        results: (Array.isArray(b.results) ? b.results : []).map(parseResult).filter((x): x is TestRunResult => !!x),
        summary: { passed: count(s.passed), failed: count(s.failed), errored: count(s.errored), unusable: count(s.unusable) },
    };
}

/** The server's machine code of a refused request, else null. */
export function testCaseErrorCode(err: unknown): string | null {
    return err instanceof ApiError ? str(obj(err.body).code) : null;
}

/** Where on the form a server refusal belongs. */
export type TestCaseErrorField = 'name' | 'input' | 'assertions' | 'general';
const FIELD_OF_CODE: Record<string, TestCaseErrorField> = {
    test_case_limit: 'general',
    test_data_not_on_prd: 'general',
    caller_run_not_capturable: 'input',
    fixture_too_large: 'input',
    fixture_truncated: 'input',
    step_not_in_run: 'input',
    run_not_found: 'input',
    run_not_finished: 'input',
};
export function testCaseErrorField(err: unknown): TestCaseErrorField {
    return FIELD_OF_CODE[testCaseErrorCode(err) || ''] || 'general';
}

const KEY = ['automation-test-cases'] as const;
const testCaseKeys = {
    all: (automationId: string) => [...KEY, automationId] as const,
    list: (automationId: string, stepId: string) => [...KEY, automationId, 'list', stepId] as const,
    detail: (automationId: string, caseId: string) => [...KEY, automationId, 'case', caseId] as const,
};

const base = (automationId: string) => `/api/automation/${encodeURIComponent(automationId)}/test-cases`;

export function useTestCases(automationId: string | null, stepId: string | null) {
    return useQuery({
        queryKey: testCaseKeys.list(automationId || '', stepId || ''),
        queryFn: async ({ signal }) => parseTestCaseList(
            await apiClient.get(base(automationId as string), { signal, query: { stepId: stepId as string }, retry: false }),
        ),
        enabled: !!automationId && !!stepId,
        staleTime: 10_000,
    });
}

/** One case with its input values (the list never carries a recorded run's values). */
export function useTestCaseInput(automationId: string | null, caseId: string | null) {
    return useQuery({
        queryKey: testCaseKeys.detail(automationId || '', caseId || ''),
        queryFn: async ({ signal }) => parseTestCaseDetail(
            await apiClient.get(`${base(automationId as string)}/${encodeURIComponent(caseId as string)}`, { signal, retry: false }),
        ),
        enabled: !!automationId && !!caseId,
    });
}

function useInvalidateCases(automationId: string | null) {
    const qc = useQueryClient();
    return () => qc.invalidateQueries({ queryKey: testCaseKeys.all(automationId || '') });
}

export function useCreateTestCase(automationId: string | null) {
    const invalidate = useInvalidateCases(automationId);
    return useMutation({
        mutationFn: async (body: TestCaseBody & { stepId: string }): Promise<TestCase | null> => {
            const res = await apiClient.post(base(automationId as string), body, { retry: false });
            return parseTestCase(obj(res).testCase);
        },
        onSuccess: invalidate,
    });
}

export function useUpdateTestCase(automationId: string | null) {
    const invalidate = useInvalidateCases(automationId);
    return useMutation({
        mutationFn: async ({ caseId, body }: { caseId: string; body: TestCaseBody }): Promise<TestCase | null> => {
            const res = await apiClient.put(`${base(automationId as string)}/${encodeURIComponent(caseId)}`, body, { retry: false });
            return parseTestCase(obj(res).testCase);
        },
        onSuccess: invalidate,
    });
}

export function useDeleteTestCase(automationId: string | null) {
    const invalidate = useInvalidateCases(automationId);
    return useMutation({
        mutationFn: async (caseId: string): Promise<void> => {
            await apiClient.delete(`${base(automationId as string)}/${encodeURIComponent(caseId)}`, { retry: false });
        },
        onSuccess: invalidate,
    });
}

export interface RunTestCasesRequest {
    stepId: string;
    caseIds?: string[];
    /** The editor's current text, so code that is not saved yet is tested. */
    code?: string;
}

/** Run cases in the sandbox. The verdicts are kept on the cases, so the list is read again. */
export function useRunTestCases(automationId: string | null) {
    const invalidate = useInvalidateCases(automationId);
    return useMutation({
        mutationFn: async (req: RunTestCasesRequest): Promise<TestRunResponse> => parseTestRun(
            await apiClient.post(`${base(automationId as string)}/run`, req, { retry: false }),
        ),
        onSettled: invalidate,
    });
}

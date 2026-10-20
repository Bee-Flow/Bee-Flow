import { describe, expect, it } from 'vitest';
import { ApiError } from '../../client';
import {
    parseTestCase,
    parseTestCaseDetail,
    parseTestCaseList,
    parseTestRun,
    testCaseErrorCode,
    testCaseErrorField,
} from './testCases';

describe('parseTestCase', () => {
    it('reads a typed case and a recorded one', () => {
        const typed = parseTestCase({
            id: 'tc_1', stepId: 's1', name: 'small', expect: 'error', lastStatus: 'pass', lastRunAt: '2026-10-20T10:00:00Z',
            assertions: [{ id: 'a1', op: 'has_key', path: '', value: 'message' }],
            input: { kind: 'typed', values: { amount: 5 } },
        });
        expect(typed).toMatchObject({ id: 'tc_1', expect: 'error', lastStatus: 'pass', input: { kind: 'typed', values: { amount: 5 } } });
        expect(typed?.assertions).toEqual([{ id: 'a1', op: 'has_key', path: '', value: 'message' }]);

        const run = parseTestCase({ id: 'tc_2', stepId: 's1', name: 'real', input: { kind: 'run', runId: 'run_1', fixtureId: 'tfx_1', available: false } });
        expect(run?.input).toEqual({ kind: 'run', runId: 'run_1', available: false });
        expect(run).toMatchObject({ expect: 'success', lastStatus: null, assertions: [] });
    });

    it('tolerates missing fields and drops what has no id or a made-up operation', () => {
        expect(parseTestCase(null)).toBeNull();
        expect(parseTestCase({ name: 'no id' })).toBeNull();
        const c = parseTestCase({ id: 'tc_3', lastStatus: 'weird', assertions: [{ id: 'x', op: 'matches_regex' }, 'junk', { id: 'ok', op: 'equals' }] });
        expect(c).toMatchObject({ name: 'tc_3', stepId: '', lastStatus: null, input: { kind: 'typed', values: null } });
        expect(c?.assertions).toEqual([{ id: 'ok', op: 'equals', path: '' }]);
    });
});

describe('parseTestCaseList and detail', () => {
    it('reads the list with its limits, and survives a body that is not one', () => {
        const l = parseTestCaseList({ testCases: [{ id: 'a' }, { nope: 1 }], limits: { perStep: 50, assertions: 25 } });
        expect(l.testCases).toHaveLength(1);
        expect(l.limits).toEqual({ perStep: 50, assertions: 25 });
        expect(parseTestCaseList(undefined)).toEqual({ testCases: [], limits: { perStep: 0, assertions: 0 } });
    });

    it('reads the values of one case from the detail answer only', () => {
        const d = parseTestCaseDetail({ testCase: { id: 'tc_1' }, input: { kind: 'run', available: true, values: { a: 1 }, runId: 'run_1' } });
        expect(d.input).toEqual({ kind: 'run', available: true, values: { a: 1 }, runId: 'run_1' });
        expect(parseTestCaseDetail(null)).toMatchObject({ testCase: null, input: { kind: 'typed', values: null } });
    });
});

describe('parseTestRun', () => {
    it('reads the verdicts, the checks and the sandbox output', () => {
        const run = parseTestRun({
            stepId: 's1',
            results: [{
                caseId: 'tc_1', name: 'small', status: 'fail', reason: null,
                expectation: { expected: 'success', got: 'success' },
                assertions: [{ id: 'a1', ok: false, code: 'wrong_count', params: { path: 'items', expected: '{"cmp":"eq","n":3}', actual: '2' } }],
                result: { items: [1, 2] }, logs: ['hello'], calls: [{ kind: 'http', name: 'GET api.example.com', args: null }], durationMs: 12,
            }, {
                caseId: 'tc_2', name: 'gone', status: 'unusable', reason: 'fixture_expired', expectation: { expected: 'success', got: null },
            }],
            summary: { passed: 0, failed: 1, errored: 0, unusable: 1 },
        });
        expect(run.summary).toEqual({ passed: 0, failed: 1, errored: 0, unusable: 1 });
        expect(run.results[0]).toMatchObject({
            status: 'fail', hasResult: true, result: { items: [1, 2] }, logs: ['hello'], durationMs: 12, error: null,
            assertions: [{ id: 'a1', ok: false, code: 'wrong_count', params: { path: 'items', expected: '{"cmp":"eq","n":3}', actual: '2' } }],
        });
        expect(run.results[0].calls).toEqual([{ kind: 'http', name: 'GET api.example.com', args: null }]);
        expect(run.results[1]).toMatchObject({ status: 'unusable', reason: 'fixture_expired', hasResult: false, assertions: [], logs: [] });
    });

    it('reads nothing from an empty answer', () => {
        expect(parseTestRun(null)).toEqual({ stepId: '', results: [], summary: { passed: 0, failed: 0, errored: 0, unusable: 0 } });
    });
});

describe('server refusals', () => {
    it('finds the code and the field it belongs to', () => {
        const err = new ApiError('This step has no recorded input in that run.', { status: 422, body: { error: 'x', code: 'step_not_in_run' } });
        expect(testCaseErrorCode(err)).toBe('step_not_in_run');
        expect(testCaseErrorField(err)).toBe('input');
        expect(testCaseErrorField(new ApiError('x', { status: 409, body: { code: 'test_case_limit' } }))).toBe('general');
        expect(testCaseErrorField(new Error('network'))).toBe('general');
        expect(testCaseErrorCode(new Error('network'))).toBeNull();
        for (const code of ['caller_run_not_capturable', 'fixture_too_large', 'fixture_truncated']) {
            expect(testCaseErrorField(new ApiError('x', { body: { code } }))).toBe('input');
        }
    });
});

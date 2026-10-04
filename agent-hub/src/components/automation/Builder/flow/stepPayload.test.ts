import { describe, expect, it } from 'vitest';
import { isDiagnosticOutputKey, stepPayload } from './stepPayload';

describe('stepPayload', () => {
    it('hands a code step\'s `result` on, not its diagnostics', () => {
        expect(stepPayload('code', { result: { a: 1 }, logs: ['x'], httpCalls: 0 })).toEqual({ a: 1 });
        expect(stepPayload('code', { result: [1, 2, 3], logs: [], httpCalls: 0 })).toEqual([1, 2, 3]);
        expect(stepPayload('code', { result: 'done', logs: [], httpCalls: 0 })).toBe('done');
    });

    it('is empty (not the logs) when the code returned nothing', () => {
        expect(stepPayload('code', { logs: ['x'], httpCalls: 0 })).toBeUndefined();
    });

    it('leaves a code output that is not shaped like the envelope alone', () => {
        const typed = { name: 'x', lines: [1] };
        expect(stepPayload('code', typed)).toBe(typed);
        expect(stepPayload('code', null)).toBeNull();
        expect(stepPayload('code', [1, 2])).toEqual([1, 2]);
    });

    it('leaves other step types and an unknown type alone', () => {
        const out = { result: 1, logs: ['x'] };
        expect(stepPayload('http_request', out)).toBe(out);
        expect(stepPayload(undefined, out)).toBe(out);
        expect(stepPayload(null, out)).toBe(out);
    });
});

describe('isDiagnosticOutputKey', () => {
    it('flags the code step\'s logs and httpCalls only', () => {
        expect(isDiagnosticOutputKey('code', 'logs')).toBe(true);
        expect(isDiagnosticOutputKey('code', 'httpCalls')).toBe(true);
        expect(isDiagnosticOutputKey('code', 'result')).toBe(false);
        expect(isDiagnosticOutputKey('integration_action', 'logs')).toBe(false);
        expect(isDiagnosticOutputKey(undefined, 'logs')).toBe(false);
    });
});

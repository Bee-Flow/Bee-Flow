import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError, errorBody, errorBodyRecord, errorCode, errorMessage, errorName, errorStatus, isAbortError, messageOf } from './caughtError';

const abort = new DOMException('The operation was aborted.', 'AbortError');
const apiError = new ApiError('Not found', { status: 404, body: { error: 'Not found', code: 'nope' } });

describe('errorMessage', () => {
    it('reads message from Error, ApiError and plain objects like e?.message', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
        expect(errorMessage(apiError)).toBe('Not found');
        expect(errorMessage({ message: 'plain' })).toBe('plain');
        expect(errorMessage(abort)).toBe('The operation was aborted.');
        expect(errorMessage(new Error(''))).toBe('');
    });
    it('is undefined where e?.message is undefined, and does not throw for null/undefined', () => {
        expect(errorMessage(null)).toBeUndefined();
        expect(errorMessage(undefined)).toBeUndefined();
        expect(errorMessage('text')).toBeUndefined();
        expect(errorMessage(42)).toBeUndefined();
        expect(errorMessage({})).toBeUndefined();
        expect(errorMessage(() => 1)).toBeUndefined();
    });
    it('drops a non-string message', () => {
        expect(errorMessage({ message: 42 })).toBeUndefined();
        expect(errorMessage({ message: { a: 1 } })).toBeUndefined();
    });
    it('reads inherited and getter properties', () => {
        class Custom extends Error {
            get message() {
                return 'from getter';
            }
        }
        expect(errorMessage(new Custom())).toBe('from getter');
    });
});

describe('messageOf', () => {
    it('matches e?.message || fallback', () => {
        const cases: unknown[] = [new Error('x'), new Error(''), apiError, 'str', null, undefined, {}, { message: '' }, 7];
        for (const c of cases) {
            const original = (c as { message?: string } | null | undefined)?.message || 'fb';
            expect(messageOf(c, 'fb')).toBe(original);
        }
    });
});

describe('describeError', () => {
    it('matches String(e?.message || e)', () => {
        expect(describeError(new Error('boom'))).toBe('boom');
        expect(describeError('plain string')).toBe('plain string');
        expect(describeError(null)).toBe('null');
        expect(describeError(undefined)).toBe('undefined');
        expect(describeError(new Error(''))).toBe('Error');
        expect(describeError({})).toBe('[object Object]');
    });
});

describe('errorStatus', () => {
    it('reads a numeric status', () => {
        expect(errorStatus(apiError)).toBe(404);
        expect(errorStatus({ status: 0 })).toBe(0);
        expect(errorStatus({ status: 500 })).toBe(500);
    });
    it('is undefined for missing, non-numeric, null and undefined', () => {
        expect(errorStatus(new Error('x'))).toBeUndefined();
        expect(errorStatus({ status: '404' })).toBeUndefined();
        expect(errorStatus(null)).toBeUndefined();
        expect(errorStatus(undefined)).toBeUndefined();
        expect(errorStatus('404')).toBeUndefined();
    });
    it('compares like e?.status === 404', () => {
        expect(errorStatus(apiError) === 404).toBe(true);
        expect(errorStatus(new Error('x')) === 404).toBe(false);
    });
});

describe('errorCode', () => {
    it('reads a string code only', () => {
        expect(errorCode({ code: 'row_conflict' })).toBe('row_conflict');
        expect(errorCode({ code: 12 })).toBeUndefined();
        expect(errorCode(new Error('x'))).toBeUndefined();
        expect(errorCode(null)).toBeUndefined();
    });
});

describe('errorBody', () => {
    it('returns the body untouched, whatever its shape', () => {
        const body = { errors: [{ message: 'bad' }] };
        expect(errorBody(new ApiError('x', { status: 422, body }))).toBe(body);
        expect(errorBody({ body: 'text' })).toBe('text');
        expect(errorBody({ body: null })).toBeNull();
    });
    it('is undefined without a body, and for null/undefined/primitives', () => {
        expect(errorBody(new Error('x'))).toBeUndefined();
        expect(errorBody(null)).toBeUndefined();
        expect(errorBody(undefined)).toBeUndefined();
        expect(errorBody('s')).toBeUndefined();
    });
});

describe('isAbortError', () => {
    it('is true for a DOMException AbortError and an Error named AbortError', () => {
        expect(isAbortError(abort)).toBe(true);
        expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    });
    it('is false for other errors, strings, null and undefined', () => {
        expect(isAbortError(new Error('x'))).toBe(false);
        expect(isAbortError(apiError)).toBe(false);
        expect(isAbortError(new DOMException('t', 'TimeoutError'))).toBe(false);
        expect(isAbortError('AbortError')).toBe(false);
        expect(isAbortError(null)).toBe(false);
        expect(isAbortError(undefined)).toBe(false);
    });
});

describe('errorName', () => {
    it('reads a string name', () => {
        expect(errorName(new Error('x'))).toBe('Error');
        expect(errorName(abort)).toBe('AbortError');
        expect(errorName(apiError)).toBe('ApiError');
        expect(errorName({ name: 5 })).toBeUndefined();
        expect(errorName(null)).toBeUndefined();
        expect(errorName(undefined)).toBeUndefined();
        expect(errorName('s')).toBeUndefined();
    });
});

describe('errorBodyRecord', () => {
    it('returns the same object for an object or array body', () => {
        const body = { playbook: 'p' };
        expect(errorBodyRecord(new ApiError('x', { body }))).toBe(body);
        const list: unknown[] = [1];
        expect(errorBodyRecord({ body: list })).toBe(list);
    });
    it('is undefined for string, number, null, missing body and null/undefined e', () => {
        expect(errorBodyRecord({ body: 'abc' })).toBeUndefined();
        expect(errorBodyRecord({ body: 3 })).toBeUndefined();
        expect(errorBodyRecord({ body: null })).toBeUndefined();
        expect(errorBodyRecord(new Error('x'))).toBeUndefined();
        expect(errorBodyRecord(null)).toBeUndefined();
        expect(errorBodyRecord(undefined)).toBeUndefined();
    });
    it('supports the spread idiom', () => {
        expect({ ok: false, ...(errorBodyRecord({ body: { a: 1 } }) ?? {}) }).toEqual({ ok: false, a: 1 });
        expect({ ok: false, ...(errorBodyRecord(null) ?? {}) }).toEqual({ ok: false });
    });
});

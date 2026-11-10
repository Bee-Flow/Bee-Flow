// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseSaveError } from './helpers';

const res = (status: number, body: string) => ({ status, text: async () => body });

describe('parseSaveError', () => {
    it('reads a JSON error body and a plain-text one', async () => {
        expect(await parseSaveError(res(403, '{"error":"Seat limit","code":"limit_reached","resource":"seats"}')))
            .toEqual({ message: 'Seat limit', code: 'limit_reached', resource: 'seats', isLimit: true });
        expect(await parseSaveError(res(502, 'Bad gateway'))).toMatchObject({ message: 'Bad gateway', isLimit: false });
    });

    it('survives a body that is valid JSON but not an object', async () => {
        // `null` parses, and reading `.error` of it threw a TypeError where the caller expected a message.
        for (const body of ['null', 'false', '0', '""', '[]', '42']) {
            expect(await parseSaveError(res(500, body))).toMatchObject({ message: 'Save failed (500)', isLimit: false });
        }
    });
});

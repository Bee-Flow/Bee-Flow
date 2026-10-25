import { describe, it, expect } from 'vitest';
import { parseSaveError, generateMessageId } from './helpers';

// parseSaveError only consumes res.status and res.text(); a minimal mock
// keeps the test independent of the fetch Response implementation.
const mockRes = (status: number, body: string) => ({ status, text: async () => body });

describe('parseSaveError', () => {
    it('extracts the message from a JSON {error} body', async () => {
        const info = await parseSaveError(mockRes(403, JSON.stringify({ error: 'Permission denied' })));
        expect(info.message).toBe('Permission denied');
        expect(info.isLimit).toBe(false);
    });

    it('extracts the message from a JSON {message} body', async () => {
        const info = await parseSaveError(mockRes(500, JSON.stringify({ message: 'Internal error' })));
        expect(info.message).toBe('Internal error');
    });

    it('passes a plain-text body through as the message', async () => {
        const info = await parseSaveError(mockRes(502, 'Bad Gateway'));
        expect(info.message).toBe('Bad Gateway');
    });

    it('falls back to "Save failed (<status>)" for an empty body', async () => {
        const info = await parseSaveError(mockRes(405, ''));
        expect(info.message).toBe('Save failed (405)');
    });

    it('flags 403 + code limit_reached as a limit error and carries code/resource', async () => {
        const info = await parseSaveError(mockRes(403, JSON.stringify({
            error: 'Organization has reached its limit of 5 agents',
            code: 'limit_reached',
            resource: 'agents',
        })));
        expect(info.isLimit).toBe(true);
        expect(info.code).toBe('limit_reached');
        expect(info.resource).toBe('agents');
    });
});

describe('generateMessageId', () => {
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('returns a v4 uuid', () => {
        expect(generateMessageId()).toMatch(V4);
    });

    it('still returns a v4 uuid where crypto.randomUUID is missing (plain HTTP)', () => {
        const original = crypto.randomUUID;
        Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
        try {
            const a = generateMessageId();
            expect(a).toMatch(V4);
            expect(generateMessageId()).not.toBe(a);
        } finally {
            Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
        }
    });
});

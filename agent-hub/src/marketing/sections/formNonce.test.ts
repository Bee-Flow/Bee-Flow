import { describe, it, expect, vi, afterEach } from 'vitest';
import { newFormNonce } from './formNonce';

// The nonce is the idempotency key of one form submission, so it must come from
// the CSPRNG on every path, including a non-secure context without randomUUID.
describe('newFormNonce', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('uses crypto.randomUUID without its dashes where the context has it', () => {
        const api = { randomUUID: () => '0b9f6c1e-7d2a-4c3b-9e8f-1a2b3c4d5e6f', getRandomValues: vi.fn() };
        expect(newFormNonce(api as unknown as Crypto)).toBe('0b9f6c1e7d2a4c3b9e8f1a2b3c4d5e6f');
        expect(api.getRandomValues).not.toHaveBeenCalled();
    });

    it('falls back to getRandomValues, never Math.random, without randomUUID', () => {
        const random = vi.spyOn(Math, 'random');
        const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(arr: T): T => {
            const bytes = arr as unknown as Uint8Array;
            for (let i = 0; i < bytes.length; i += 1) bytes[i] = i * 17;
            return arr;
        });
        const nonce = newFormNonce({ getRandomValues } as unknown as Crypto);
        expect(nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(getRandomValues).toHaveBeenCalledTimes(1);
        expect(random).not.toHaveBeenCalled();
    });
});

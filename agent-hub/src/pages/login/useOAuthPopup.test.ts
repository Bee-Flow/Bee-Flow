import { describe, it, expect, vi, afterEach } from 'vitest';
import { microsoftLoginUrl, newPickupId } from './useOAuthPopup';

describe('microsoftLoginUrl', () => {
    it('names the connection only for an additional tenant, and the popup only when embedded', () => {
        expect(microsoftLoginUrl('https://api.example', undefined, false)).toBe('https://api.example/auth/login/microsoft');
        expect(microsoftLoginUrl('https://api.example', 'default', false)).toBe('https://api.example/auth/login/microsoft');
        expect(microsoftLoginUrl('https://api.example', 'sub', false)).toBe('https://api.example/auth/login/microsoft?connection=sub');
        expect(microsoftLoginUrl('https://api.example', 'sub', true)).toBe('https://api.example/auth/login/microsoft?popup=1&connection=sub');
    });
});

// The pickup id is what the OAuth callback files the session token under, so
// it must come from the CSPRNG on every path, including a non-secure context
// where crypto.randomUUID is absent.
describe('newPickupId', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('uses crypto.randomUUID where the context has it', () => {
        const api = { randomUUID: () => '0b9f6c1e-7d2a-4c3b-9e8f-1a2b3c4d5e6f', getRandomValues: vi.fn() };
        expect(newPickupId(api as unknown as Crypto)).toBe('0b9f6c1e-7d2a-4c3b-9e8f-1a2b3c4d5e6f');
        expect(api.getRandomValues).not.toHaveBeenCalled();
    });

    it('falls back to getRandomValues, never Math.random, without randomUUID', () => {
        const random = vi.spyOn(Math, 'random');
        const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(arr: T): T => {
            const bytes = arr as unknown as Uint8Array;
            for (let i = 0; i < bytes.length; i += 1) bytes[i] = i * 17;
            return arr;
        });
        const id = newPickupId({ getRandomValues } as unknown as Crypto);
        expect(getRandomValues).toHaveBeenCalledTimes(1);
        expect(random).not.toHaveBeenCalled();
        expect(id).toBe('00112233445566778899aabbccddeeff');
    });

    it('gives 128 random bits as 32 hex characters on the fallback path', () => {
        const real = globalThis.crypto;
        const id = newPickupId({ getRandomValues: real.getRandomValues.bind(real) } as unknown as Crypto);
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(newPickupId({ getRandomValues: real.getRandomValues.bind(real) } as unknown as Crypto)).not.toBe(id);
    });
});

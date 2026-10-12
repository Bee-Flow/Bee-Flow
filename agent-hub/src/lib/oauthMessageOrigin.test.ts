import { describe, expect, it } from 'vitest';
import { isTrustedOAuthOrigin } from './oauthMessageOrigin';

describe('isTrustedOAuthOrigin', () => {
    it('trusts the SPA origin', () => {
        expect(isTrustedOAuthOrigin(window.location.origin)).toBe(true);
    });
    it('trusts the API origin when it differs (dev)', () => {
        expect(isTrustedOAuthOrigin('http://localhost:3101', 'http://localhost:3101')).toBe(true);
    });
    it('rejects a foreign origin', () => {
        expect(isTrustedOAuthOrigin('https://evil.example', 'http://localhost:3101')).toBe(false);
        expect(isTrustedOAuthOrigin('null')).toBe(false);
    });
});

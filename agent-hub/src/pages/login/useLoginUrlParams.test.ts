import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLoginUrlParams } from './useLoginUrlParams';

const t = (_key: string | undefined, fallback?: unknown) => String(fallback ?? '');

function runWith(search: string) {
    window.history.replaceState({}, '', `/login${search}`);
    const setError = vi.fn();
    renderHook(() => useLoginUrlParams({ t: t as never, setResetToken: vi.fn(), setVerifiedBanner: vi.fn(), setError }));
    return setError;
}

describe('SSO redirect errors on the login page', () => {
    afterEach(() => window.history.replaceState({}, '', '/'));

    it('says the provider has not verified the e-mail address', () => {
        const setError = runWith('?error=sso_email_unverified');
        expect(setError).toHaveBeenCalledWith(expect.stringMatching(/not verified your e-mail address/));
    });

    it('explains an unlinked sign-in without naming one provider', () => {
        const setError = runWith('?error=sso_link_required');
        const message = String(setError.mock.calls[0]?.[0]);
        expect(message).toMatch(/not linked to an account/);
        expect(message).not.toMatch(/Microsoft/);
    });
});

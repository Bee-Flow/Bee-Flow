import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import MfaLoginStep from './MfaLoginStep';
import { securityKeysSupported } from '../../api/queries/securityKeys';

/**
 * CHARACTERISATION — the second-factor prompt exactly as it behaves today (L0).
 *
 * Shown by LoginPage once /auth/admin-login answers `{ mfaRequired: true }`.
 * The step owns no requests: it collects a code and hands it up. What it does
 * own is the toggle between an authenticator code and a recovery code — and
 * the fact that both go up the SAME callback, which the server tells apart.
 *
 * `t()` is stubbed to the source's own fallback string (or the bare key when
 * the source passes none), so these tests survive the dictionary rewrite that
 * is happening in another track.
 */
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));
// jsdom has no WebAuthn; the security-key cases decide per test whether the
// browser "has" it.
vi.mock('../../api/queries/securityKeys', () => ({ securityKeysSupported: vi.fn(() => true) }));

function renderStep(overrides = {}) {
    const p = {
        onVerify: vi.fn(),
        onCancel: vi.fn(),
        isLoading: false,
        inputClass: 'input', labelClass: 'label',
        ...overrides,
    };
    return { ...render(<MfaLoginStep {...p} />), p };
}

describe('asking for the second factor', () => {
    it('asks for the six-digit code from the authenticator app', () => {
        renderStep();
        expect(screen.getByText('Enter the 6-digit code from your authenticator app')).toBeInTheDocument();
        expect(screen.getByTestId('mfa-code-input')).toHaveAttribute('placeholder', '000000');
        expect(screen.getByTestId('mfa-code-input')).toHaveAttribute('inputmode', 'numeric');
    });

    it('offers the code to a one-time-code autofill', () => {
        renderStep();
        expect(screen.getByTestId('mfa-code-input')).toHaveAttribute('autocomplete', 'one-time-code');
    });

    it('keeps the verify button dead until something is typed', () => {
        renderStep();
        expect(screen.getByTestId('mfa-verify-button')).toBeDisabled();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '123456' } });
        expect(screen.getByTestId('mfa-verify-button')).not.toBeDisabled();
    });

    it('hands the trimmed code up on submit', () => {
        const { p } = renderStep();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '  123456 ' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        expect(p.onVerify).toHaveBeenCalledWith('123456');
    });

    // wrat: nothing here restricts the field to six digits — no maxLength, no
    // pattern, no digits-only filter (the forced-enrollment gate,
    // MfaSetupGate, does cap it at 6). A typo of seven digits is sent to the
    // server and comes back as "invalid code". Hoort in stage L12 te veranderen.
    it('sends whatever was typed, however long, to the server', () => {
        const { p } = renderStep();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '1234567890' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        expect(p.onVerify).toHaveBeenCalledWith('1234567890');
        expect(screen.getByTestId('mfa-code-input')).not.toHaveAttribute('maxlength');
    });

    it('locks the verify button while the code is being checked', () => {
        renderStep({ isLoading: true });
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '123456' } });
        expect(screen.getByTestId('mfa-verify-button')).toBeDisabled();
    });
});

describe('the way out when the authenticator is gone', () => {
    it('swaps to a recovery code and clears whatever was half-typed', () => {
        renderStep();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '123' } });
        fireEvent.click(screen.getByText('Use a recovery code'));
        expect(screen.getByText('Enter one of your one-time recovery codes')).toBeInTheDocument();
        expect(screen.getByTestId('mfa-code-input')).toHaveValue('');
        expect(screen.getByTestId('mfa-code-input')).toHaveAttribute('placeholder', 'xxxx-xxxx');
    });

    it('swaps back to the authenticator app', () => {
        renderStep();
        fireEvent.click(screen.getByText('Use a recovery code'));
        fireEvent.click(screen.getByText('Use your authenticator app instead'));
        expect(screen.getByText('Enter the 6-digit code from your authenticator app')).toBeInTheDocument();
    });

    // wrat: a recovery code travels up the SAME onVerify callback with no flag
    // of its own, so the client cannot tell the server which of the two it is
    // sending — /auth/mfa/verify-login has to guess from the shape. Hoort in
    // stage L16 te veranderen als de fouttoestanden per soort uiteen moeten.
    it('sends a recovery code through the very same callback as a TOTP code', () => {
        const { p } = renderStep();
        fireEvent.click(screen.getByText('Use a recovery code'));
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: 'abcd-efgh' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        expect(p.onVerify).toHaveBeenCalledWith('abcd-efgh');
        expect(p.onVerify).toHaveBeenCalledTimes(1);
    });

    it('names the escalation path for someone with neither (BFSF-274)', () => {
        renderStep();
        expect(screen.getByText(/Locked out\? Use a recovery code, or ask your organization admin/)).toBeInTheDocument();
    });

    it('offers a way back to the login form', () => {
        const { p } = renderStep();
        fireEvent.click(screen.getByText('Back'));
        expect(p.onCancel).toHaveBeenCalled();
    });
});

describe('a security key on the account', () => {
    const withKey = (overrides = {}) => renderStep({ methods: ['totp', 'security_key'], onSecurityKey: vi.fn(), ...overrides });

    it('opens on the key: one button, which hands up to onSecurityKey', async () => {
        const { p } = withKey();
        expect(screen.getByText('Insert your security key and touch it when it flashes.')).toBeInTheDocument();
        expect(screen.queryByTestId('mfa-code-input')).not.toBeInTheDocument();
        await userEvent.click(screen.getByTestId('mfa-security-key-button'));
        expect(p.onSecurityKey).toHaveBeenCalledTimes(1);
        expect(p.onVerify).not.toHaveBeenCalled();
    });

    it('keeps the authenticator code one click away, and the key one click back', async () => {
        withKey();
        await userEvent.click(screen.getByRole('button', { name: 'Use your authenticator app instead' }));
        expect(screen.getByTestId('mfa-code-input')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Use your security key instead' }));
        expect(screen.getByTestId('mfa-security-key-button')).toBeInTheDocument();
    });

    it('still offers a recovery code from the key view', async () => {
        withKey();
        await userEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
        expect(screen.getByTestId('mfa-code-input')).toHaveAttribute('placeholder', 'xxxx-xxxx');
    });

    it('locks the key button while the sign-in is being checked', () => {
        withKey({ isLoading: true });
        expect(screen.getByTestId('mfa-security-key-button')).toBeDisabled();
    });

    it('falls back to the code in a browser without WebAuthn', () => {
        vi.mocked(securityKeysSupported).mockReturnValueOnce(false);
        withKey();
        expect(screen.getByTestId('mfa-code-input')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Use your security key instead' })).not.toBeInTheDocument();
    });

    it('never mentions a key for an account without one', () => {
        renderStep({ methods: ['totp'], onSecurityKey: vi.fn() });
        expect(screen.getByTestId('mfa-code-input')).toBeInTheDocument();
        expect(screen.queryByText(/security key/i)).not.toBeInTheDocument();
    });
});

describe('an account with security keys only', () => {
    const keyOnly = (overrides = {}) => renderStep({ methods: ['security_key'], onSecurityKey: vi.fn(), ...overrides });

    it('opens on the key and never offers an authenticator code it does not have', async () => {
        keyOnly();
        expect(screen.getByTestId('mfa-security-key-button')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Use your authenticator app instead' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
        expect(screen.getByTestId('mfa-code-input')).toHaveAttribute('placeholder', 'xxxx-xxxx');
        expect(screen.queryByRole('button', { name: 'Use your authenticator app instead' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Use your security key instead' }));
        expect(screen.getByTestId('mfa-security-key-button')).toBeInTheDocument();
    });

    it('in a browser that cannot use the key, opens on the recovery code and says why', () => {
        vi.mocked(securityKeysSupported).mockReturnValueOnce(false);
        keyOnly();
        expect(screen.getByTestId('mfa-code-input')).toHaveAttribute('placeholder', 'xxxx-xxxx');
        expect(screen.getByTestId('mfa-key-unavailable')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Use your authenticator app instead' })).not.toBeInTheDocument();
    });
});

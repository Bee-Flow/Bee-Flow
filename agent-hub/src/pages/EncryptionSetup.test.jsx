import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, fail } from '@/test/http';
import EncryptionSetup from './EncryptionSetup';
import { opaquePinRegister, opaquePinLogin } from '../lib/opaque';
import { authFetch } from '../utils/helpers';

/**
 * CHARACTERISATION — the encryption gate between signing in and the app (L0).
 *
 * AuthedApp renders this instead of the app when /auth/user reports
 * `needsEncryptionSetup` / `needsEncryptionPin`, and again straight after login
 * whenever a recovery key was minted. For the user it is part of signing in,
 * and for the Playwright suite it is the gate global-setup has to click
 * through, so its ids are pinned in LoginPage.e2eSelectors.test.jsx's spirit.
 *
 * The zero-knowledge promise on this screen is "the PIN never reaches the
 * server". That promise has a fallback path behind it, which is pinned below
 * exactly as it behaves — see the warts.
 */
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../lib/opaque', () => ({ opaquePinRegister: vi.fn(), opaquePinLogin: vi.fn() }));

let routes;
const isPath = (url, path) => {
    const u = String(url);
    return u === path || u.startsWith(`${path}/`) || u.startsWith(`${path}?`);
};
const route = (path, handler) => routes.unshift([path, handler]);
const callTo = (path) => authFetch.mock.calls.find(([u]) => isPath(u, path));
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    authFetch.mockReset();
    opaquePinRegister.mockReset();
    opaquePinLogin.mockReset();
    routes = [];
    authFetch.mockImplementation((url, options) => {
        const u = String(url);
        const hit = routes.find(([path]) => isPath(u, path));
        return hit ? hit[1](options, u) : fail(404, { error: `unrouted: ${u}` });
    });
});

afterEach(() => { vi.restoreAllMocks(); });

const renderGate = (props = {}) => {
    const onComplete = vi.fn();
    return { ...render(<EncryptionSetup onComplete={onComplete} {...props} />), onComplete };
};

const typePin = (pin, confirm = pin) => {
    fireEvent.change(screen.getByTestId('encryption-pin'), { target: { value: pin } });
    const confirmField = screen.queryByTestId('encryption-pin-confirm');
    if (confirmField) fireEvent.change(confirmField, { target: { value: confirm } });
    fireEvent.click(screen.getByTestId('encryption-submit'));
};

describe('choosing an encryption PIN for the first time', () => {
    it('explains that this PIN is not the SSO password', () => {
        renderGate({ mode: 'setup' });
        expect(screen.getByText('Set Up Data Encryption')).toBeInTheDocument();
        expect(screen.getByText(/separate from your SSO login/)).toBeInTheDocument();
        expect(screen.getByText(/The server cannot read your encrypted data without it/)).toBeInTheDocument();
    });

    it('refuses a PIN under six characters without any request', () => {
        renderGate({ mode: 'setup' });
        typePin('12345');
        expect(screen.getByText('PIN must be at least 6 characters')).toBeInTheDocument();
        expect(opaquePinRegister).not.toHaveBeenCalled();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('refuses two PINs that do not match', () => {
        renderGate({ mode: 'setup' });
        typePin('123456', '654321');
        expect(screen.getByText('PINs do not match')).toBeInTheDocument();
        expect(opaquePinRegister).not.toHaveBeenCalled();
    });

    it('registers the PIN through OPAQUE and shows the recovery key it returns', async () => {
        opaquePinRegister.mockResolvedValue({ success: true, recoveryKey: 'AAAA-BBBB-CCCC' });
        renderGate({ mode: 'setup' });
        typePin('correct-pin');
        expect(await screen.findByTestId('encryption-recovery-key')).toHaveTextContent('AAAA-BBBB-CCCC');
        expect(opaquePinRegister).toHaveBeenCalledWith('correct-pin');
        expect(callTo('/auth/sso-encryption-setup')).toBeFalsy();
    });

    // wrat: "PIN never sent to server" holds only while OPAQUE succeeds. Both
    // a thrown error AND a success without a recovery key fall through to
    // /auth/sso-encryption-setup, which posts the PIN in the clear. The screen
    // says nothing about the difference. Hoort in stage L16 te veranderen.
    it('posts the PIN to the server when the OPAQUE registration throws', async () => {
        opaquePinRegister.mockRejectedValue(new Error('wasm unavailable'));
        route('/auth/sso-encryption-setup', () => ok({ success: true, recoveryKey: 'LEGACY-KEY' }));
        renderGate({ mode: 'setup' });
        typePin('correct-pin');
        await waitFor(() => expect(callTo('/auth/sso-encryption-setup')).toBeTruthy());
        expect(bodyOf(callTo('/auth/sso-encryption-setup'))).toEqual({ pin: 'correct-pin' });
        expect(await screen.findByTestId('encryption-recovery-key')).toHaveTextContent('LEGACY-KEY');
    });

    // wrat: same fallback, quieter trigger — OPAQUE reported success but no key.
    // Hoort in stage L16 te veranderen.
    it('posts the PIN to the server when OPAQUE succeeded but returned no key', async () => {
        opaquePinRegister.mockResolvedValue({ success: true });
        route('/auth/sso-encryption-setup', () => ok({ success: true, recoveryKey: 'LEGACY-KEY' }));
        renderGate({ mode: 'setup' });
        typePin('correct-pin');
        await waitFor(() => expect(callTo('/auth/sso-encryption-setup')).toBeTruthy());
    });

    it('shows the server\'s reason when the legacy setup is refused', async () => {
        opaquePinRegister.mockRejectedValue(new Error('nope'));
        route('/auth/sso-encryption-setup', () => fail(400, { error: 'PIN too common' }));
        renderGate({ mode: 'setup' });
        typePin('correct-pin');
        expect(await screen.findByText('PIN too common')).toBeInTheDocument();
    });

    // wrat: every message on this screen is a hardcoded English literal —
    // 'PIN must be at least 6 characters', 'PINs do not match', 'Setup failed',
    // 'Connection error', 'Incorrect PIN'. The headings around them ARE
    // translated, so a Dutch user gets a Dutch screen with English errors.
    // Hoort in stage L16 te veranderen (samen met de i18n-retrofit).
    it('reports a connection failure in untranslated English', async () => {
        opaquePinRegister.mockRejectedValue(new Error('nope'));
        route('/auth/sso-encryption-setup', () => Promise.reject(new Error('offline')));
        renderGate({ mode: 'setup' });
        typePin('correct-pin');
        expect(await screen.findByText('Connection error')).toBeInTheDocument();
    });
});

describe('unlocking with an existing PIN', () => {
    it('asks only for the PIN — no confirmation field', () => {
        renderGate({ mode: 'unlock' });
        expect(screen.getByText('Unlock Your Data')).toBeInTheDocument();
        expect(screen.getByTestId('encryption-pin')).toBeInTheDocument();
        expect(screen.queryByTestId('encryption-pin-confirm')).toBeNull();
    });

    it('refuses an empty PIN without any request', () => {
        renderGate({ mode: 'unlock' });
        fireEvent.click(screen.getByTestId('encryption-submit'));
        expect(screen.getByText('Please enter your encryption PIN')).toBeInTheDocument();
        expect(opaquePinLogin).not.toHaveBeenCalled();
    });

    it('lets you in when OPAQUE accepts the PIN, without contacting the legacy route', async () => {
        opaquePinLogin.mockResolvedValue({ success: true });
        const { onComplete } = renderGate({ mode: 'unlock' });
        typePin('correct-pin');
        await waitFor(() => expect(onComplete).toHaveBeenCalled());
        expect(callTo('/auth/sso-encryption-unlock')).toBeFalsy();
    });

    // Deliberate, and load-bearing: an account still on kdfMode
    // 'legacy_argon2' has no opaqueRecord, and returning early here trapped it
    // in a reload loop. The fall-through is the fix — pinned so it stays.
    it('falls through to the legacy route when OPAQUE says the account has no record', async () => {
        opaquePinLogin.mockResolvedValue({ success: false, needsSetup: true });
        route('/auth/sso-encryption-unlock', () => ok({ success: true }));
        const { onComplete } = renderGate({ mode: 'unlock' });
        typePin('correct-pin');
        await waitFor(() => expect(callTo('/auth/sso-encryption-unlock')).toBeTruthy());
        expect(bodyOf(callTo('/auth/sso-encryption-unlock'))).toEqual({ pin: 'correct-pin' });
        expect(onComplete).toHaveBeenCalled();
    });

    it('shows the server\'s reason for refusing the PIN', async () => {
        opaquePinLogin.mockResolvedValue({ success: false });
        route('/auth/sso-encryption-unlock', () => fail(401, { error: 'Incorrect PIN' }));
        const { onComplete } = renderGate({ mode: 'unlock' });
        typePin('wrong-pin');
        expect(await screen.findByText('Incorrect PIN')).toBeInTheDocument();
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('offers the recovery key as a way out, with a new PIN', async () => {
        renderGate({ mode: 'unlock' });
        fireEvent.click(screen.getByText('Forgot your PIN? Use recovery key'));
        expect(screen.getByText('Recover Your Account')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Paste your recovery key here')).toBeInTheDocument();
    });
});

describe('recovering with the recovery key', () => {
    const openRecovery = () => {
        const rendered = renderGate({ mode: 'unlock' });
        fireEvent.click(screen.getByText('Forgot your PIN? Use recovery key'));
        return rendered;
    };

    const fillRecovery = (key, pin, confirm = pin) => {
        fireEvent.change(screen.getByPlaceholderText('Paste your recovery key here'), { target: { value: key } });
        fireEvent.change(screen.getByPlaceholderText('Minimum 6 characters'), { target: { value: pin } });
        fireEvent.change(screen.getByPlaceholderText('Confirm your new PIN'), { target: { value: confirm } });
        fireEvent.click(screen.getByText('Recover & Set New PIN'));
    };

    it('refuses an empty recovery key', () => {
        openRecovery();
        fireEvent.click(screen.getByText('Recover & Set New PIN'));
        expect(screen.getByText('Please enter your recovery key')).toBeInTheDocument();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('refuses a new PIN under six characters', () => {
        openRecovery();
        fillRecovery('AAAA-BBBB', '123');
        expect(screen.getByText('New PIN must be at least 6 characters')).toBeInTheDocument();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('posts the trimmed key with the new PIN and shows the fresh recovery key', async () => {
        route('/auth/sso-recovery', () => ok({ success: true, recoveryKey: 'NEW-KEY-1234' }));
        openRecovery();
        fillRecovery('  AAAA-BBBB  ', 'brand-new-pin');
        await waitFor(() => expect(callTo('/auth/sso-recovery')).toBeTruthy());
        expect(bodyOf(callTo('/auth/sso-recovery'))).toEqual({
            recoveryKey: 'AAAA-BBBB', newPin: 'brand-new-pin',
        });
        expect(await screen.findByTestId('encryption-recovery-key')).toHaveTextContent('NEW-KEY-1234');
    });

    it('shows the server\'s reason for refusing the recovery key', async () => {
        route('/auth/sso-recovery', () => fail(400, { error: 'Recovery key does not match' }));
        openRecovery();
        fillRecovery('AAAA-BBBB', 'brand-new-pin');
        expect(await screen.findByText('Recovery key does not match')).toBeInTheDocument();
    });

    it('walks back to PIN entry, forgetting what was typed', () => {
        openRecovery();
        fireEvent.change(screen.getByPlaceholderText('Paste your recovery key here'), { target: { value: 'AAAA' } });
        fireEvent.click(screen.getByText('Back to PIN entry'));
        expect(screen.getByText('Unlock Your Data')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Forgot your PIN? Use recovery key'));
        expect(screen.getByPlaceholderText('Paste your recovery key here')).toHaveValue('');
    });
});

describe('the recovery-key screen the e2e suite has to click through', () => {
    it('shows a key handed down as a prop, with the warning and the only exit', () => {
        const { onComplete } = renderGate({ mode: 'recovery', recoveryKeyProp: 'PROP-KEY-9999' });
        expect(screen.getByTestId('encryption-recovery-key')).toHaveTextContent('PROP-KEY-9999');
        expect(screen.getByText(/permanently inaccessible/)).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('encryption-recovery-saved'));
        expect(onComplete).toHaveBeenCalled();
    });

    // The Playwright gate helpers match this button by its English label
    // (/saved my recovery key/i). The id above is the stable hook; the label is
    // pinned here so a copy change cannot silently break the suite.
    it('keeps the label the Playwright gate helpers match on', () => {
        renderGate({ mode: 'recovery', recoveryKeyProp: 'PROP-KEY-9999' });
        expect(screen.getByTestId('encryption-recovery-saved'))
            .toHaveTextContent("I've saved my recovery key — Continue");
    });

    // wrat: the key screen takes over from every mode, and its only control is
    // "Continue" — no confirmation, no second showing, and the copy button is
    // the sole way to keep it. Same shape as the operator's recovery-key modal
    // on the login screen. Hoort in stage L16 te veranderen.
    it('offers no way back and no second chance', () => {
        renderGate({ mode: 'recovery', recoveryKeyProp: 'PROP-KEY-9999' });
        expect(screen.getByTestId('encryption-recovery-key')).toBeInTheDocument();
        expect(screen.queryByTestId('encryption-pin')).toBeNull();
        expect(screen.queryByText(/Back/i)).toBeNull();
    });
});

import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, fail } from '@/test/http';
import MfaSetupGate from './MfaSetupGate';
import { authFetch } from '../../utils/helpers';

/**
 * CHARACTERISATION — the forced two-factor enrollment gate (L0).
 *
 * Not part of signing in as such: AuthedApp renders this INSTEAD of the app
 * once /auth/user reports `mfaSetupRequired`. It is still part of the sign-in
 * surface, because for the user it is the screen between "I typed my password"
 * and "I am in", and because it is the only screen with no way forward except
 * enrolling or signing out.
 *
 * The AI helper is stubbed to a marker — it takes no props by design (BFSF-274:
 * it must never be handed the QR, the setup key or a code) and it has requests
 * of its own that are not this screen's contract.
 */
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));
// Every render's props, so "hands it nothing" is asserted, not assumed.
const helpProps = [];
vi.mock('../../components/mfa/MfaHelpAssistant', () => ({
    default: (props) => { helpProps.push(props); return <div data-testid="mfa-help-assistant" />; },
}));
// jsdom has no WebAuthn: off by default, as a browser without it; the
// security-key cases switch it on.
vi.mock('@simplewebauthn/browser', () => ({
    browserSupportsWebAuthn: vi.fn(() => false),
    startRegistration: vi.fn(async () => ({ id: 'k', rawId: 'k', type: 'public-key', response: {} })),
    startAuthentication: vi.fn(),
}));

const SETUP_PAYLOAD = { qr: 'data:image/png;base64,QR', secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' };

let routes;
const isPath = (url, path) => {
    const u = String(url);
    return u === path || u.startsWith(`${path}/`) || u.startsWith(`${path}?`);
};
const route = (path, handler) => routes.unshift([path, handler]);
const callsTo = (path) => authFetch.mock.calls.filter(([u]) => isPath(u, path));
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
    helpProps.length = 0;
    authFetch.mockReset();
    routes = [['/auth/mfa/setup', () => ok({ ...SETUP_PAYLOAD })]];
    authFetch.mockImplementation((url, options) => {
        const u = String(url);
        const hit = routes.find(([path]) => isPath(u, path));
        return hit ? hit[1](options, u) : fail(404, { error: `unrouted: ${u}` });
    });
});

afterEach(() => { vi.restoreAllMocks(); });

const renderGate = () => {
    const onDone = vi.fn();
    const onLogout = vi.fn();
    return { ...render(<MfaSetupGate onDone={onDone} onLogout={onLogout} />), onDone, onLogout };
};

describe('landing on the gate', () => {
    it('starts enrollment on its own so the QR is there without a click', async () => {
        renderGate();
        await waitFor(() => expect(callsTo('/auth/mfa/setup')).toHaveLength(1));
        expect(await screen.findByAltText('MFA QR code')).toHaveAttribute('src', 'data:image/png;base64,QR');
    });

    // BFSF-274: twee gelijktijdige /setup-calls racen op session.save, waarna de
    // QR op het scherm bij een ander secret hoort dan de sessie bewaart en elke
    // ingetikte code "Invalid" is. De module-level in-flight guard laat er
    // daarom maar een door, ook als het scherm twee keer tegelijk gemonteerd
    // wordt (remount, of het dubbele effect van StrictMode in dev).
    it('fires a single /auth/mfa/setup when two gates mount at the same time', async () => {
        render(
            <>
                <MfaSetupGate onDone={vi.fn()} onLogout={vi.fn()} />
                <MfaSetupGate onDone={vi.fn()} onLogout={vi.fn()} />
            </>,
        );
        await waitFor(() => expect(screen.getAllByAltText('MFA QR code')).toHaveLength(2));
        expect(callsTo('/auth/mfa/setup')).toHaveLength(1);
    });

    it('says what 2FA is, why this screen is here and what to install', async () => {
        renderGate();
        await screen.findByAltText('MFA QR code');
        expect(screen.getByText('Set up two-factor authentication')).toBeInTheDocument();
        expect(screen.getByText(/adds a second step to signing in/)).toBeInTheDocument();
        expect(screen.getByText(/required for accounts that sign in with a password/)).toBeInTheDocument();
        expect(screen.getByText(/Google Authenticator, Microsoft Authenticator, 1Password or Bitwarden/)).toBeInTheDocument();
    });

    // BFSF-280: the duty is on by default, so a self-signup with no
    // administrator lands here too; the screen must not name one.
    it('does not blame an administrator', async () => {
        renderGate();
        await screen.findByAltText('MFA QR code');
        expect(screen.queryByText(/administrator/i)).toBeNull();
    });

    it('offers the setup as a link that opens the authenticator app on this device', async () => {
        renderGate();
        const link = await screen.findByRole('link', { name: /Add to the authenticator app on this device/ });
        expect(link).toHaveAttribute('href', SETUP_PAYLOAD.otpauthUrl);
    });

    // BFSF-280: a fixed-height box centred on a phone overflowed at the top,
    // where scrolling never reaches; the gate grows with its card instead.
    it('lets the page grow with the card instead of a fixed screen-height box', async () => {
        const { container } = renderGate();
        await screen.findByAltText('MFA QR code');
        expect(container.firstChild).toHaveClass('min-h-full');
        expect(container.firstChild).not.toHaveClass('h-screen');
    });

    it('walks through three numbered steps, not just the first', async () => {
        const { container } = renderGate();
        await screen.findByAltText('MFA QR code');
        const steps = container.querySelectorAll('ol li');
        expect(steps).toHaveLength(3);
        expect(steps[0].textContent).toMatch(/Install an authenticator app/);
        expect(steps[1].textContent).toMatch(/Scan QR code/);
        expect(steps[2].textContent).toMatch(/Enter the 6-digit code/);
    });

    it('offers the setup key for anyone who cannot scan', async () => {
        renderGate();
        await screen.findByAltText('MFA QR code');
        expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    });

    it('offers the AI helper, and hands it nothing', async () => {
        renderGate();
        expect(await screen.findByTestId('mfa-help-assistant')).toBeInTheDocument();
        expect(helpProps.length).toBeGreaterThan(0);
        for (const props of helpProps) expect(props).toEqual({});
    });

    it('shows why enrollment could not be started', async () => {
        route('/auth/mfa/setup', () => fail(500, { error: 'TOTP secret store unavailable' }));
        renderGate();
        expect(await screen.findByText('TOTP secret store unavailable')).toBeInTheDocument();
        expect(screen.queryByAltText('MFA QR code')).toBeNull();
    });

    // wrat: a failed /setup leaves the screen with no QR, no code field and no
    // retry — only "Sign Out". The user is locked out of the product by a
    // server-side hiccup. Hoort in stage L16 te veranderen.
    it('offers no retry at all when enrollment could not be started', async () => {
        route('/auth/mfa/setup', () => fail(500, { error: 'TOTP secret store unavailable' }));
        const { onLogout } = renderGate();
        await screen.findByText('TOTP secret store unavailable');
        expect(screen.queryByPlaceholderText('000000')).toBeNull();
        fireEvent.click(screen.getByText('Sign Out'));
        expect(onLogout).toHaveBeenCalled();
    });
});

describe('confirming the first code', () => {
    const arrive = async () => {
        const rendered = renderGate();
        await screen.findByAltText('MFA QR code');
        return rendered;
    };

    it('keeps the enable button dead until six characters are typed', async () => {
        await arrive();
        const enable = screen.getByText('Enable').closest('button');
        expect(enable).toBeDisabled();
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '12345' } });
        expect(enable).toBeDisabled();
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
        expect(enable).not.toBeDisabled();
    });

    it('caps the code field at six characters', async () => {
        await arrive();
        expect(screen.getByPlaceholderText('000000')).toHaveAttribute('maxlength', '6');
    });

    it('posts the trimmed code to /auth/mfa/enable', async () => {
        route('/auth/mfa/enable', () => ok({ recoveryCodes: ['aaaa-1111', 'bbbb-2222'] }));
        await arrive();
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
        fireEvent.click(screen.getByText('Enable'));
        await waitFor(() => expect(callsTo('/auth/mfa/enable')).toHaveLength(1));
        expect(bodyOf(callsTo('/auth/mfa/enable')[0])).toEqual({ code: '123456' });
    });

    it('shows the one-time recovery codes and only then lets you through', async () => {
        route('/auth/mfa/enable', () => ok({ recoveryCodes: ['aaaa-1111', 'bbbb-2222'] }));
        const { onDone } = await arrive();
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
        fireEvent.click(screen.getByText('Enable'));
        expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();
        expect(screen.getByText('bbbb-2222')).toBeInTheDocument();
        expect(onDone).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('I’ve saved them'));
        expect(onDone).toHaveBeenCalled();
    });

    it('keeps you on the QR with the reason when the code is refused', async () => {
        route('/auth/mfa/enable', () => fail(400, { error: 'Invalid code' }));
        await arrive();
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '000000' } });
        fireEvent.click(screen.getByText('Enable'));
        expect(await screen.findByText('Invalid code')).toBeInTheDocument();
        expect(screen.getByAltText('MFA QR code')).toBeInTheDocument();
    });

    // wrat: a successful enable that returns no `recoveryCodes` still switches
    // to the codes panel — with an empty list and a button that says the user
    // saved codes they were never shown. Hoort in stage L16 te veranderen.
    it('shows an empty "saved your codes" panel when the server returned none', async () => {
        route('/auth/mfa/enable', () => ok({}));
        const { onDone } = await arrive();
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
        fireEvent.click(screen.getByText('Enable'));
        expect(await screen.findByText(/Save these one-time recovery codes/)).toBeInTheDocument();
        fireEvent.click(screen.getByText('I’ve saved them'));
        expect(onDone).toHaveBeenCalled();
    });
});

describe('the ways out of the gate', () => {
    it('offers signing out and nothing else — there is deliberately no skip', async () => {
        const { onLogout } = renderGate();
        await screen.findByAltText('MFA QR code');
        fireEvent.click(screen.getByText('Sign Out'));
        expect(onLogout).toHaveBeenCalled();
        expect(screen.queryByText(/skip/i)).toBeNull();
        expect(screen.queryByText(/later/i)).toBeNull();
    });
});

describe('a security key instead of an app', () => {
    const jsonOk = (body) => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });

    it('is not offered in a browser that cannot use one', async () => {
        renderGate();
        await screen.findByAltText('MFA QR code');
        expect(screen.queryByText('Use a security key instead')).toBeNull();
    });

    it('satisfies the duty: touch the key, save the codes, continue', async () => {
        vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
        route('/auth/mfa/security-keys/registration/options', () => jsonOk({ options: { challenge: 'c' } }));
        route('/auth/mfa/security-keys/registration/verify', () => jsonOk({ key: { id: 'k1' }, recoveryCodes: ['aaaa-1111'] }));
        const { onDone } = renderGate();
        await userEvent.click(await screen.findByText('Use a security key instead'));
        await userEvent.type(screen.getByLabelText('Name'), 'YubiKey');
        await userEvent.click(screen.getByRole('button', { name: 'Add security key' }));

        expect(await screen.findByText('aaaa-1111')).toBeInTheDocument();
        expect(bodyOf(callsTo('/auth/mfa/security-keys/registration/options')[0])).toEqual({ name: 'YubiKey' });
        expect(onDone).not.toHaveBeenCalled();
        vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
    });
});

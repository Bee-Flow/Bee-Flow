import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, fail } from '@/test/http';
import LoginPage from './LoginPage';
import { opaqueLogin } from '../lib/opaque';
import { authFetch } from '../utils/helpers';

/**
 * CHARACTERISATION — signing in, exactly as it works today (L0).
 *
 * The safety net for the L-track redesign. Everything here pins CURRENT
 * behaviour, warts included: which request goes out, what the user sees back,
 * and what happens when the server refuses. A test that describes how sign-in
 * OUGHT to work does not belong in this file.
 *
 * This file covers the password path, its failure modes, the transparent
 * OPAQUE hand-off and the second-factor step. The recovery paths (forgot /
 * reset / e-mail verification / first-run setup / invite) live next door in
 * LoginPage.recovery.test.jsx.
 *
 * Two deliberate stubs:
 *  - `t()` returns the source's own fallback string, or the bare key when the
 *    source passes none. The dictionaries are owned by another track and are
 *    being rewritten; asserting on keys pins WHICH message is shown without
 *    tying this net to this week's copy.
 *  - `opaqueLogin` is stubbed: the real one loads a wasm OPAQUE client and
 *    talks to /auth/opaque/* outside authFetch.
 */
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(), setSessionToken: vi.fn() }));
vi.mock('../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../lib/opaque', () => ({ opaqueLogin: vi.fn() }));
// jsdom has no authenticator: the browser half of a security-key sign-in is
// stubbed, the requests around it are real calls into the mocked authFetch.
vi.mock('@simplewebauthn/browser', () => ({
    browserSupportsWebAuthn: vi.fn(() => true),
    startAuthentication: vi.fn(async () => ({ id: 'cred', rawId: 'cred', type: 'public-key', response: {} })),
    startRegistration: vi.fn(),
}));
vi.mock('./login/SignupWizard', () => ({ default: () => <div data-testid="signup-wizard" /> }));
// Dead import in LoginPage (nothing renders it) — stubbed so the whole install
// wizard is not pulled into this test's module graph. See the warts list.
vi.mock('../components/InitSetupWizard', () => ({ default: () => null }));

const SETUP_STATUS = {
    isSetupComplete: true,
    isOAuthConfigured: false,
    isGoogleConfigured: false,
    isMicrosoftConfigured: false,
    allowSignups: true,
    allowPasswordLogin: true,
    deploymentMode: 'cloud',
};

let routes;
// Path match, not substring match: `/auth/setup` must not swallow
// `/auth/setup-status`, while `/auth/invite` still catches `/auth/invite/<token>`.
const isPath = (url, path) => {
    const u = String(url);
    return u === path || u.startsWith(`${path}/`) || u.startsWith(`${path}?`);
};
/** Register a response for `path` (and anything under it). Last registered wins. */
const route = (path, handler) => routes.unshift([path, handler]);
const callTo = (path) => authFetch.mock.calls.find(([u]) => isPath(u, path));
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/');
    authFetch.mockReset();
    opaqueLogin.mockReset();
    routes = [
        ['/auth/setup-status', () => ok({ ...SETUP_STATUS })],
        ['/auth/organizations/public', () => ok([])],
        ['/auth/pending-invite', () => ok({ valid: false })],
    ];
    authFetch.mockImplementation((url, options) => {
        const u = String(url);
        const hit = routes.find(([path]) => isPath(u, path));
        return hit ? hit[1](options, u) : fail(404, { error: `unrouted: ${u}` });
    });
});

afterEach(() => { vi.restoreAllMocks(); });

async function renderLogin() {
    const onLogin = vi.fn();
    const utils = render(<LoginPage onLogin={onLogin} />);
    await screen.findByTestId('login-submit-button');
    return { ...utils, onLogin };
}

function signIn(username = 'ada@example.com', password = 'hunter2') {
    fireEvent.change(screen.getByTestId('username'), { target: { value: username } });
    fireEvent.change(screen.getByTestId('password'), { target: { value: password } });
    fireEvent.submit(screen.getByTestId('login-submit-button').closest('form'));
}

describe('what the screen asks the server before it draws anything', () => {
    it('shows a spinner instead of a form until the auth settings have landed', async () => {
        const { container } = render(<LoginPage onLogin={vi.fn()} />);
        // De spinner zelf pinnen, niet alleen de afwezigheid van het formulier:
        // `allowPasswordLogin` start op null, dus de velden blijven ook weg
        // wanneer de spinner-tak volledig zou verdwijnen.
        expect(container.querySelector('.animate-spin')).not.toBeNull();
        expect(screen.queryByTestId('login-submit-button')).toBeNull();
        expect(screen.queryByTestId('username')).toBeNull();
        await screen.findByTestId('login-submit-button');
        expect(container.querySelector('.animate-spin')).toBeNull();
    });

    it('asks /auth/setup-status which methods this deployment offers', async () => {
        await renderLogin();
        expect(callTo('/auth/setup-status')).toBeTruthy();
    });

    // wrat: the anonymous login screen still fetches the public organisation
    // directory on every load, even though that endpoint stopped answering
    // anonymously on cloud (it was disclosing the whole customer list) and the
    // result now only feeds the signup wizard. Hoort in stage L1 te veranderen.
    it('also fetches the public organisation list before anyone has asked to sign up', async () => {
        await renderLogin();
        expect(callTo('/auth/organizations/public')).toBeTruthy();
    });

    it('asks whether a server-side invite is waiting for this browser', async () => {
        await renderLogin();
        expect(callTo('/auth/pending-invite')).toBeTruthy();
    });

    it('falls back to showing every method when setup-status answers with an error', async () => {
        route('/auth/setup-status', () => fail(500, { error: 'boom' }));
        await renderLogin();
        expect(screen.getByTestId('username')).toBeInTheDocument();
        expect(screen.getByTestId('create-account-button')).toBeInTheDocument();
    });

    // wrat: `setAuthSettingsLoaded(true)` sits INSIDE the try, after the await.
    // A setup-status that rejects (offline, DNS, CORS) therefore jumps straight
    // to the catch, and the screen keeps spinning forever — no form, no error,
    // no retry. The non-2xx path above is handled; the throwing one is not.
    // Hoort in stage L16 te veranderen.
    it('spins forever, with no error and no form, when setup-status never arrives', async () => {
        route('/auth/setup-status', () => Promise.reject(new Error('offline')));
        const { container } = render(<LoginPage onLogin={vi.fn()} />);
        await waitFor(() => expect(console.error).toHaveBeenCalled());
        expect(container.querySelector('.animate-spin')).not.toBeNull();
        expect(screen.queryByTestId('login-submit-button')).toBeNull();
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.queryByText(/login\.connection_error/)).toBeNull();
    });

    it('offers a language picker only when the server lists more than one locale', async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, availableLocales: [{ code: 'en' }] }));
        const { container } = await renderLogin();
        expect(container.querySelector('select')).toBeNull();
    });

    it('offers a language picker when the server lists several locales', async () => {
        route('/auth/setup-status', () => ok({
            ...SETUP_STATUS, availableLocales: [{ code: 'en' }, { code: 'nl' }],
        }));
        const { container } = await renderLogin();
        expect(container.querySelector('select')).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'NL' })).toBeInTheDocument();
    });

    it('wears the organisation logo and the "powered by" line on a self-hosted server', async () => {
        route('/auth/setup-status', () => ok({
            ...SETUP_STATUS, deploymentMode: 'self-hosted', branding: { logo: '/uploads/org.png' },
        }));
        await renderLogin();
        expect(screen.getByAltText('Organization')).toHaveAttribute('src', '/uploads/org.png');
        expect(screen.getByText('Powered by Bee Flow')).toBeInTheDocument();
    });

    it('wears the Bee Flow logo and no "powered by" line on cloud', async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, branding: { logo: '/uploads/org.png' } }));
        await renderLogin();
        expect(screen.getByAltText('Bee Flow')).toBeInTheDocument();
        expect(screen.queryByText('Powered by Bee Flow')).toBeNull();
    });

    it('drops the create-account button when the server closed signups', async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, allowSignups: false }));
        await renderLogin();
        expect(screen.queryByTestId('create-account-button')).toBeNull();
    });
});

describe('signing in with a password', () => {
    it('posts the typed credentials to /auth/admin-login as JSON', async () => {
        route('/auth/admin-login', () => ok({ success: true, user: { id: 'u1' } }));
        await renderLogin();
        signIn('ada@example.com', 'hunter2');
        await waitFor(() => expect(callTo('/auth/admin-login')).toBeTruthy());
        const [, options] = callTo('/auth/admin-login');
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/json');
        expect(bodyOf(callTo('/auth/admin-login'))).toEqual({ username: 'ada@example.com', password: 'hunter2' });
    });

    it('hands the user and any recovery key straight to the app', async () => {
        route('/auth/admin-login', () => ok({ success: true, user: { id: 'u1' }, recoveryKey: 'RK-1234' }));
        const { onLogin } = await renderLogin();
        signIn();
        await waitFor(() => expect(onLogin).toHaveBeenCalledWith({ id: 'u1' }, 'RK-1234'));
    });

    it('shows the server\'s refusal for a wrong password', async () => {
        route('/auth/admin-login', () => fail(401, { error: 'Invalid credentials' }));
        await renderLogin();
        signIn();
        expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    });

    // The server answers an unknown account with the exact same 401 body, on
    // purpose (no account enumeration) — so the screen has nothing to tell
    // apart, and neither does this test. Pinned so a redesign cannot "helpfully"
    // add a "no such account" state.
    it('treats an unknown account exactly like a wrong password', async () => {
        route('/auth/admin-login', () => fail(401, { error: 'Invalid credentials' }));
        await renderLogin();
        signIn('nobody@example.com', 'whatever');
        expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
        expect(screen.getByTestId('username')).toBeInTheDocument();
    });

    // wrat: the throttle sends `code: 'too_many_attempts'` and a `retryAfter`
    // in seconds; the screen renders `data.error` and throws both away. A
    // locked-out user gets "please wait" with no idea how long, and no
    // countdown. Hoort in stage L16 te veranderen.
    it('shows the lockout sentence but silently drops the retry-after the server sent', async () => {
        route('/auth/admin-login', () => fail(429, {
            error: 'Too many failed sign-in attempts. Please wait and try again.',
            code: 'too_many_attempts',
            retryAfter: 42,
        }));
        await renderLogin();
        signIn();
        expect(await screen.findByText(/Too many failed sign-in attempts/)).toBeInTheDocument();
        expect(screen.queryByText(/42/)).toBeNull();
        expect(screen.queryByText(/too_many_attempts/)).toBeNull();
    });

    it('shows the SSO-only refusal on a server with password login disabled', async () => {
        route('/auth/admin-login', () => fail(403, { error: 'Password login is disabled on this server.' }));
        await renderLogin();
        signIn();
        expect(await screen.findByText('Password login is disabled on this server.')).toBeInTheDocument();
    });

    it('falls back to a generic message when the refusal carries no text', async () => {
        route('/auth/admin-login', () => fail(401, {}));
        await renderLogin();
        signIn();
        expect(await screen.findByText('login.login_failed')).toBeInTheDocument();
    });

    it('reports a connection error when the request never lands', async () => {
        route('/auth/admin-login', () => Promise.reject(new Error('offline')));
        await renderLogin();
        signIn();
        expect(await screen.findByText('login.connection_error')).toBeInTheDocument();
    });

    it('replaces the previous complaint on the next attempt instead of stacking them', async () => {
        let n = 0;
        route('/auth/admin-login', () => fail(401, { error: n++ === 0 ? 'First refusal' : 'Second refusal' }));
        await renderLogin();
        signIn();
        await screen.findByText('First refusal');
        signIn();
        expect(await screen.findByText('Second refusal')).toBeInTheDocument();
        expect(screen.queryByText('First refusal')).toBeNull();
    });

    it('lets you try again with the form still filled in', async () => {
        route('/auth/admin-login', () => fail(401, { error: 'Invalid credentials' }));
        await renderLogin();
        signIn('ada@example.com', 'hunter2');
        await screen.findByText('Invalid credentials');
        expect(screen.getByTestId('username')).toHaveValue('ada@example.com');
        expect(screen.getByTestId('password')).toHaveValue('hunter2');
        expect(screen.getByTestId('login-submit-button')).not.toBeDisabled();
    });

    // wrat: the error block is a plain <div>. No role="alert", no aria-live —
    // so a screen-reader user submits the form and is told nothing at all.
    // Hoort in stage L16 te veranderen.
    it('announces a failed sign-in to nobody using a screen reader', async () => {
        route('/auth/admin-login', () => fail(401, { error: 'Invalid credentials' }));
        const { container } = await renderLogin();
        signIn();
        await screen.findByText('Invalid credentials');
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.querySelector('[aria-live]')).toBeNull();
    });
});

describe('the transparent hand-off to OPAQUE', () => {
    it('runs the OPAQUE handshake with the same credentials when the server asks for it', async () => {
        route('/auth/admin-login', () => ok({ useOpaque: true }));
        opaqueLogin.mockResolvedValue({ success: true, user: { id: 'u1' } });
        const { onLogin } = await renderLogin();
        signIn('ada@example.com', 'hunter2');
        await waitFor(() => expect(opaqueLogin).toHaveBeenCalledWith('ada@example.com', 'hunter2'));
        expect(onLogin).toHaveBeenCalledWith({ id: 'u1' });
    });

    // wrat: the bcrypt path calls onLogin(user, recoveryKey); the OPAQUE path
    // calls onLogin(user) and drops whatever the finish response carried, so a
    // freshly-minted recovery key is never shown on this path. Hoort in stage
    // L16 te veranderen.
    it('never forwards a recovery key from the OPAQUE finish response', async () => {
        route('/auth/admin-login', () => ok({ useOpaque: true }));
        opaqueLogin.mockResolvedValue({ success: true, user: { id: 'u1' }, recoveryKey: 'RK-1234' });
        const { onLogin } = await renderLogin();
        signIn();
        await waitFor(() => expect(onLogin).toHaveBeenCalled());
        expect(onLogin.mock.calls[0]).toHaveLength(1);
    });

    it('asks the user to contact an admin when OPAQUE reports a legacy account', async () => {
        route('/auth/admin-login', () => ok({ useOpaque: true }));
        opaqueLogin.mockResolvedValue({ useLegacy: true });
        const { onLogin } = await renderLogin();
        signIn();
        expect(await screen.findByText('login.auth_error_contact_admin')).toBeInTheDocument();
        expect(onLogin).not.toHaveBeenCalled();
    });

    it('falls back to the generic failure when OPAQUE returns neither', async () => {
        route('/auth/admin-login', () => ok({ useOpaque: true }));
        opaqueLogin.mockResolvedValue({ success: false });
        await renderLogin();
        signIn();
        expect(await screen.findByText('login.login_failed')).toBeInTheDocument();
    });

    // wrat: the raw exception message is put on screen. Whatever the OPAQUE
    // client or the server happens to throw — including internal wording — is
    // shown to an anonymous visitor. Hoort in stage L16 te veranderen.
    it('prints the raw exception text from the OPAQUE client to the user', async () => {
        route('/auth/admin-login', () => ok({ useOpaque: true }));
        opaqueLogin.mockRejectedValue(new Error('Login start failed: envelope corrupt'));
        await renderLogin();
        signIn();
        expect(await screen.findByText('Login start failed: envelope corrupt')).toBeInTheDocument();
    });

    // wrat: `data.useOpaque` is read BEFORE `res.ok`, so a refusal that happens
    // to carry the flag starts a full OPAQUE handshake anyway instead of
    // showing the refusal. Hoort in stage L16 te veranderen.
    it('starts the OPAQUE handshake even when the response was a 401', async () => {
        route('/auth/admin-login', () => fail(401, { useOpaque: true, error: 'Invalid credentials' }));
        opaqueLogin.mockResolvedValue({ success: false });
        await renderLogin();
        signIn();
        await waitFor(() => expect(opaqueLogin).toHaveBeenCalled());
        expect(screen.queryByText('Invalid credentials')).toBeNull();
    });

    // wrat: the OPAQUE branch is checked before the mfaRequired branch, so an
    // OPAQUE account is never asked for a second factor here — matching the
    // server, which routes OPAQUE logins around its own MFA gate
    // (auth/login/passwordLoginRoutes.js). Hoort in stage L16 te veranderen.
    it('skips the second factor entirely for an OPAQUE account', async () => {
        route('/auth/admin-login', () => ok({ useOpaque: true, mfaRequired: true }));
        opaqueLogin.mockResolvedValue({ success: true, user: { id: 'u1' } });
        const { onLogin } = await renderLogin();
        signIn();
        await waitFor(() => expect(onLogin).toHaveBeenCalled());
        expect(screen.queryByTestId('mfa-code-input')).toBeNull();
    });
});

describe('the second factor', () => {
    const arriveAtMfa = async () => {
        route('/auth/admin-login', () => ok({ mfaRequired: true }));
        const rendered = await renderLogin();
        signIn();
        await screen.findByTestId('mfa-code-input');
        return rendered;
    };

    it('replaces the credentials form with the code prompt once the password checks out', async () => {
        await arriveAtMfa();
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.queryByTestId('password')).toBeNull();
        expect(screen.getByText('Two-factor authentication')).toBeInTheDocument();
    });

    it('posts only the code to /auth/mfa/verify-login — the session carries the rest', async () => {
        route('/auth/mfa/verify-login', () => ok({ success: true, user: { id: 'u1' } }));
        await arriveAtMfa();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        await waitFor(() => expect(callTo('/auth/mfa/verify-login')).toBeTruthy());
        expect(bodyOf(callTo('/auth/mfa/verify-login'))).toEqual({ code: '123456' });
    });

    it('signs the user in with the payload the verify step returned', async () => {
        route('/auth/mfa/verify-login', () => ok({ success: true, user: { id: 'u1' }, recoveryKey: 'RK-9' }));
        const { onLogin } = await arriveAtMfa();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        await waitFor(() => expect(onLogin).toHaveBeenCalledWith({ id: 'u1' }, 'RK-9'));
    });

    it('keeps you on the code prompt and shows why a wrong code was refused', async () => {
        route('/auth/mfa/verify-login', () => fail(401, { error: 'Invalid or expired code' }));
        await arriveAtMfa();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '000000' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        expect(await screen.findByText('Invalid or expired code')).toBeInTheDocument();
        expect(screen.getByTestId('mfa-code-input')).toBeInTheDocument();
    });

    it('falls back to its own wording when the refusal carries no text', async () => {
        route('/auth/mfa/verify-login', () => fail(401, {}));
        await arriveAtMfa();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '000000' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        expect(await screen.findByText('Invalid code. Please try again.')).toBeInTheDocument();
    });

    it('reports a connection error when the verify request never lands', async () => {
        route('/auth/mfa/verify-login', () => Promise.reject(new Error('offline')));
        await arriveAtMfa();
        fireEvent.change(screen.getByTestId('mfa-code-input'), { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('mfa-verify-button'));
        expect(await screen.findByText('login.connection_error')).toBeInTheDocument();
    });

    // wrat: "Back" only resets client state — the server still holds the
    // half-authenticated `session.mfaPending` blob (including the password, so
    // the DEK can be derived after the code). Nothing tells the server the user
    // walked away. Hoort in stage L16 te veranderen.
    it('walks back to the credentials form, keeping the e-mail and dropping the password', async () => {
        await arriveAtMfa();
        fireEvent.click(screen.getByText('Back'));
        await screen.findByTestId('username');
        expect(screen.getByTestId('username')).toHaveValue('ada@example.com');
        expect(screen.getByTestId('password')).toHaveValue('');
        expect(callTo('/auth/mfa/cancel')).toBeFalsy();
    });
});

describe('the second factor with a security key', () => {
    // apiClient reads content-type on a success, which the shared ok() lacks.
    const jsonOk = (body) => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });

    const arriveAtKey = async () => {
        route('/auth/admin-login', () => ok({ mfaRequired: true, mfaMethods: ['totp', 'security_key'] }));
        route('/auth/mfa/security-key/options', () => jsonOk({ options: { challenge: 'abc', rpId: 'localhost' } }));
        const rendered = await renderLogin();
        signIn();
        await screen.findByTestId('mfa-security-key-button');
        return rendered;
    };

    it('opens on the key when the account has one, and signs in with a touch', async () => {
        route('/auth/mfa/security-key/verify-login', () => jsonOk({ success: true, user: { id: 'u1' }, recoveryKey: 'RK-1' }));
        const { onLogin } = await arriveAtKey();
        await userEvent.click(screen.getByTestId('mfa-security-key-button'));
        await waitFor(() => expect(onLogin).toHaveBeenCalledWith({ id: 'u1' }, 'RK-1'));
        expect(callTo('/auth/mfa/security-key/options')).toBeTruthy();
    });

    it('keeps you on the step, with the reason, when the key is refused', async () => {
        route('/auth/mfa/security-key/verify-login', () => fail(401, { error: 'x', code: 'security_key_rejected' }));
        await arriveAtKey();
        await userEvent.click(screen.getByTestId('mfa-security-key-button'));
        expect(await screen.findByText('The security key could not be verified. Try again.')).toBeInTheDocument();
        expect(screen.getByTestId('mfa-security-key-button')).toBeInTheDocument();
    });

    it('sends you back to the password once the attempts are spent, saying why', async () => {
        route('/auth/admin-login', () => ok({ mfaRequired: true }));
        route('/auth/mfa/verify-login', () => fail(401, {
            error: 'Too many incorrect codes. Sign in again with your password.', code: 'mfa_attempts_exhausted',
        }));
        await renderLogin();
        signIn();
        await userEvent.type(await screen.findByTestId('mfa-code-input'), '000000');
        await userEvent.click(screen.getByTestId('mfa-verify-button'));
        expect(await screen.findByText('Too many incorrect codes. Sign in again with your password.')).toBeInTheDocument();
        expect(screen.getByTestId('password')).toHaveValue('');
        expect(screen.queryByTestId('mfa-code-input')).toBeNull();
    });
});

describe('SSO provisioning failures come back as ?error=', () => {
    afterEach(() => { window.history.replaceState({}, '', '/'); });

    it.each([['seat_cap_exceeded', /user limit/], ['signup_failed', /could not be created/]])(
        'explains %s instead of showing a bare login page', async (code, text) => {
            window.history.replaceState({}, '', `/?error=${code}`);
            await renderLogin();
            expect(await screen.findByText(text)).toBeTruthy();
        });
});

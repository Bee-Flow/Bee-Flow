import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, fail } from '@/test/http';
import LoginPage from './LoginPage';
import { authFetch } from '../utils/helpers';

/**
 * CHARACTERISATION — everything on the sign-in screen that is NOT a password
 * being checked (L0): first-run setup, the recovery key, forgotten passwords,
 * reset links, the e-mail-verification gate and invite links.
 *
 * Same rules as LoginPage.test.jsx: pin today's behaviour, warts included. All
 * of these paths are entered from the URL or from a single server flag, and
 * several of them deliberately say the same thing whether or not an account
 * exists — which is exactly the property a redesign is most likely to "fix".
 */
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(), setSessionToken: vi.fn() }));
vi.mock('../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../lib/opaque', () => ({ opaqueLogin: vi.fn() }));
// The wizard itself is characterised elsewhere (SignupWizard.test.jsx); here it
// only has to be identifiable, and to show the `error` prop it really renders —
// LoginPage's invite failures land there, not on the sign-in screen.
vi.mock('./login/SignupWizard', () => ({
    default: ({ error }) => <div data-testid="signup-wizard">{error}</div>,
}));
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
const route = (path, handler) => routes.unshift([path, handler]);
const callTo = (path) => authFetch.mock.calls.find(([u]) => isPath(u, path));
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/');
    authFetch.mockReset();
    routes = [
        ['/auth/setup-status', () => ok({ ...SETUP_STATUS })],
        ['/auth/organizations/public', () => ok([])],
        ['/auth/pending-invite', () => ok({ valid: false })],
        ['/billing/public-plans', () => ok({ plans: [] })],
    ];
    authFetch.mockImplementation((url, options) => {
        const u = String(url);
        const hit = routes.find(([path]) => isPath(u, path));
        return hit ? hit[1](options, u) : fail(404, { error: `unrouted: ${u}` });
    });
});

afterEach(() => { vi.restoreAllMocks(); });

const renderLogin = () => {
    const onLogin = vi.fn();
    return { ...render(<LoginPage onLogin={onLogin} />), onLogin };
};

describe('the first-run root password', () => {
    const firstRun = async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, isSetupComplete: false }));
        const rendered = renderLogin();
        await screen.findByTestId('root-password');
        return rendered;
    };

    const fillRootPassword = (pw, confirm) => {
        fireEvent.change(screen.getByTestId('root-password'), { target: { value: pw } });
        fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: confirm } });
        fireEvent.submit(screen.getByTestId('login-submit-button').closest('form'));
    };

    it('asks for a root password instead of a sign-in when the server is not set up', async () => {
        await firstRun();
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.getByText('login.create_admin_password')).toBeInTheDocument();
    });

    it('refuses a mismatched pair without touching the server', async () => {
        await firstRun();
        fillRootPassword('Password1', 'Password2');
        expect(await screen.findByText('login.passwords_no_match')).toBeInTheDocument();
        expect(callTo('/auth/setup')).toBeFalsy();
    });

    // wrat: the setup request carries the password and nothing else — no
    // username, no e-mail — so the operator account's name is decided entirely
    // server-side and never shown on this screen. Hoort in stage L2 te
    // veranderen.
    it('posts only the password to /auth/setup', async () => {
        route('/auth/setup', () => ok({}));
        await firstRun();
        fillRootPassword('Password1', 'Password1');
        await waitFor(() => expect(callTo('/auth/setup')).toBeTruthy());
        expect(bodyOf(callTo('/auth/setup'))).toEqual({ password: 'Password1' });
    });

    it('shows the recovery key once, before letting anyone continue', async () => {
        route('/auth/setup', () => ok({ recoveryKey: 'AAAA-BBBB-CCCC-DDDD' }));
        await firstRun();
        fillRootPassword('Password1', 'Password1');
        expect(await screen.findByTestId('recovery-key-modal')).toBeInTheDocument();
        expect(screen.getByTestId('recovery-key-value')).toHaveTextContent('AAAA-BBBB-CCCC-DDDD');
    });

    it('lands on the normal sign-in form once the key is acknowledged', async () => {
        route('/auth/setup', () => ok({ recoveryKey: 'AAAA-BBBB' }));
        await firstRun();
        fillRootPassword('Password1', 'Password1');
        fireEvent.click(await screen.findByTestId('recovery-key-saved'));
        expect(await screen.findByTestId('username')).toBeInTheDocument();
        expect(screen.queryByTestId('recovery-key-modal')).toBeNull();
    });

    // wrat: dismissing the modal is the ONLY exit and it is a plain button —
    // no confirmation, no "type it back", no second chance. A misclick loses
    // the operator's recovery key silently. Hoort in stage L16 te veranderen.
    it('offers no confirmation step before the key disappears for good', async () => {
        route('/auth/setup', () => ok({ recoveryKey: 'AAAA-BBBB' }));
        await firstRun();
        fillRootPassword('Password1', 'Password1');
        fireEvent.click(await screen.findByTestId('recovery-key-saved'));
        await screen.findByTestId('username');
        expect(screen.queryByText('AAAA-BBBB')).toBeNull();
    });

    it('slips straight to the sign-in form when the server minted no recovery key', async () => {
        route('/auth/setup', () => ok({ ok: true }));
        await firstRun();
        fillRootPassword('Password1', 'Password1');
        expect(await screen.findByTestId('username')).toBeInTheDocument();
        expect(screen.queryByTestId('recovery-key-modal')).toBeNull();
    });

    it('shows the server\'s complaint about a weak root password', async () => {
        route('/auth/setup', () => fail(400, { error: 'Password must contain a number' }));
        await firstRun();
        fillRootPassword('password', 'password');
        expect(await screen.findByText('Password must contain a number')).toBeInTheDocument();
        expect(screen.getByTestId('root-password')).toBeInTheDocument();
    });

    it('falls back to a generic message when setup fails without one', async () => {
        route('/auth/setup', () => fail(500, {}));
        await firstRun();
        fillRootPassword('Password1', 'Password1');
        expect(await screen.findByText('login.setup_failed')).toBeInTheDocument();
    });
});

describe('forgetting your password', () => {
    const openForgot = async () => {
        const rendered = renderLogin();
        await screen.findByTestId('login-submit-button');
        fireEvent.click(screen.getByText('Forgot password?'));
        await screen.findByTestId('forgot-email-input');
        return rendered;
    };

    it('swaps the sign-in form for the e-mail step', async () => {
        await openForgot();
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.getByText('Forgot your password?')).toBeInTheDocument();
    });

    it('posts the address to /auth/forgot-password', async () => {
        route('/auth/forgot-password', () => ok({ success: true }));
        await openForgot();
        fireEvent.change(screen.getByTestId('forgot-email-input'), { target: { value: 'ada@example.com' } });
        fireEvent.click(screen.getByText('Send reset link'));
        await waitFor(() => expect(callTo('/auth/forgot-password')).toBeTruthy());
        expect(bodyOf(callTo('/auth/forgot-password'))).toEqual({ email: 'ada@example.com' });
    });

    it('gives the same non-committal answer for an address that has no account', async () => {
        route('/auth/forgot-password', () => ok({ success: true }));
        await openForgot();
        fireEvent.change(screen.getByTestId('forgot-email-input'), { target: { value: 'nobody@example.com' } });
        fireEvent.click(screen.getByText('Send reset link'));
        expect(await screen.findByText(/If an account exists for that email/)).toBeInTheDocument();
    });

    // wrat: the catch branch also flips `forgotSent`, so a request that never
    // reached the server is indistinguishable from a delivered mail. The user
    // waits for an e-mail that was never sent. Hoort in stage L16 te veranderen.
    it('claims the mail is on its way even when the request never left the browser', async () => {
        route('/auth/forgot-password', () => Promise.reject(new Error('offline')));
        await openForgot();
        fireEvent.change(screen.getByTestId('forgot-email-input'), { target: { value: 'ada@example.com' } });
        fireEvent.click(screen.getByText('Send reset link'));
        expect(await screen.findByText(/If an account exists for that email/)).toBeInTheDocument();
    });

    // wrat: a 500 gets the same treatment for a different reason — the response
    // is never inspected at all. Hoort in stage L16 te veranderen.
    it('claims the mail is on its way when the server answered with a 500', async () => {
        route('/auth/forgot-password', () => fail(500, { error: 'mailer down' }));
        await openForgot();
        fireEvent.change(screen.getByTestId('forgot-email-input'), { target: { value: 'ada@example.com' } });
        fireEvent.click(screen.getByText('Send reset link'));
        expect(await screen.findByText(/If an account exists for that email/)).toBeInTheDocument();
        expect(screen.queryByText('mailer down')).toBeNull();
    });

    it('walks back to the sign-in form', async () => {
        await openForgot();
        fireEvent.click(screen.getAllByText('Back to sign in')[0]);
        expect(await screen.findByTestId('username')).toBeInTheDocument();
    });
});

describe('arriving on a reset link', () => {
    const openReset = async (token = 'reset-token-123') => {
        window.history.replaceState({}, '', `/?reset=${token}`);
        const rendered = renderLogin();
        await screen.findByTestId('reset-new-password');
        return rendered;
    };

    const setNewPassword = (pw) => {
        fireEvent.change(screen.getByTestId('reset-new-password'), { target: { value: pw } });
        const [, confirm] = screen.getAllByPlaceholderText('••••••••');
        fireEvent.change(confirm, { target: { value: pw } });
        fireEvent.click(screen.getByText('Set new password'));
    };

    it('opens the new-password form instead of the sign-in form', async () => {
        await openReset();
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.getByText('Reset your password')).toBeInTheDocument();
    });

    it('scrubs the token out of the address bar immediately', async () => {
        await openReset();
        expect(window.location.search).toBe('');
    });

    it('posts the token together with the new password', async () => {
        route('/auth/reset-password', () => ok({ success: true }));
        await openReset('reset-token-123');
        setNewPassword('correct-horse');
        await waitFor(() => expect(callTo('/auth/reset-password')).toBeTruthy());
        expect(bodyOf(callTo('/auth/reset-password'))).toEqual({
            token: 'reset-token-123', newPassword: 'correct-horse',
        });
    });

    it('confirms and offers the way back to sign in', async () => {
        route('/auth/reset-password', () => ok({ success: true }));
        await openReset();
        setNewPassword('correct-horse');
        expect(await screen.findByText(/Your password has been reset/)).toBeInTheDocument();
        fireEvent.click(screen.getByText('Go to sign in'));
        expect(await screen.findByTestId('username')).toBeInTheDocument();
    });

    it('shows the server\'s reason for refusing an expired link', async () => {
        route('/auth/reset-password', () => fail(400, { error: 'This reset link has expired' }));
        await openReset();
        setNewPassword('correct-horse');
        expect(await screen.findByText('This reset link has expired')).toBeInTheDocument();
    });

    // wrat: a refused reset leaves the user on the same form with no way out —
    // the "back to sign in" button only exists on the success panel, and the
    // token is already gone from the URL, so a refresh lands them on a plain
    // sign-in screen with no explanation. Hoort in stage L16 te veranderen.
    it('leaves a refused reset with no route back to the sign-in form', async () => {
        route('/auth/reset-password', () => fail(400, { error: 'This reset link has expired' }));
        await openReset();
        setNewPassword('correct-horse');
        await screen.findByText('This reset link has expired');
        expect(screen.queryByText('Go to sign in')).toBeNull();
        expect(screen.queryByText('Back to sign in')).toBeNull();
    });

    it('falls back to its own wording when the refusal carries no text', async () => {
        route('/auth/reset-password', () => fail(400, {}));
        await openReset();
        setNewPassword('correct-horse');
        expect(await screen.findByText('Failed to reset password.')).toBeInTheDocument();
    });
});

describe('the e-mail-verification gate', () => {
    const blockedLogin = async (username = 'ada@example.com') => {
        route('/auth/admin-login', () => ok({ emailVerificationRequired: true }));
        const rendered = renderLogin();
        await screen.findByTestId('login-submit-button');
        fireEvent.change(screen.getByTestId('username'), { target: { value: username } });
        fireEvent.change(screen.getByTestId('password'), { target: { value: 'hunter2' } });
        fireEvent.submit(screen.getByTestId('login-submit-button').closest('form'));
        await screen.findByText('Confirm your email address');
        return rendered;
    };

    it('replaces the whole screen with an "check your inbox" gate', async () => {
        await blockedLogin();
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.getByText('We sent a confirmation link to')).toBeInTheDocument();
        expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    });

    it('resends the link through /auth/resend-verification', async () => {
        route('/auth/resend-verification', () => ok({ success: true }));
        await blockedLogin();
        fireEvent.click(screen.getByText('Resend confirmation email'));
        await waitFor(() => expect(callTo('/auth/resend-verification')).toBeTruthy());
        expect(bodyOf(callTo('/auth/resend-verification'))).toEqual({ email: 'ada@example.com' });
        expect(await screen.findByText(/a new link is on its way/)).toBeInTheDocument();
    });

    it('shows the same neutral confirmation when the resend request fails', async () => {
        route('/auth/resend-verification', () => Promise.reject(new Error('offline')));
        await blockedLogin();
        fireEvent.click(screen.getByText('Resend confirmation email'));
        expect(await screen.findByText(/a new link is on its way/)).toBeInTheDocument();
    });

    // wrat: the address is only carried over when the typed username contains
    // an "@". Sign in as `admin` on a self-hosted server and the gate asks you
    // to type an address it already knows, and refuses to resend until you do.
    // Hoort in stage L16 te veranderen.
    it('asks a username-only account to retype an address the server already has', async () => {
        await blockedLogin('admin');
        expect(screen.getByText(/We sent you a confirmation link/)).toBeInTheDocument();
        expect(screen.getByPlaceholderText('you@example.com')).toHaveValue('');
        expect(screen.getByText('Resend confirmation email').closest('button')).toBeDisabled();
    });

    it('walks back to the sign-in form', async () => {
        await blockedLogin();
        fireEvent.click(screen.getByText('Back to login'));
        expect(await screen.findByTestId('username')).toBeInTheDocument();
    });
});

describe('coming back from a verification link', () => {
    it('welcomes a confirmed address and cleans the URL', async () => {
        window.history.replaceState({}, '', '/?verified=1');
        renderLogin();
        expect(await screen.findByText('Your email is confirmed. You can now log in.')).toBeInTheDocument();
        expect(window.location.search).toBe('');
    });

    it('explains an expired verification link and cleans the URL', async () => {
        window.history.replaceState({}, '', '/?error=verify_expired');
        renderLogin();
        expect(await screen.findByText(/This verification link is invalid or has expired/)).toBeInTheDocument();
        expect(window.location.search).toBe('');
    });

    it('ignores an error code that is not about verification', async () => {
        window.history.replaceState({}, '', '/?error=something_else');
        renderLogin();
        await screen.findByTestId('login-submit-button');
        expect(screen.queryByText(/verification link/)).toBeNull();
        // wrat: the URL is only scrubbed for verify_* errors, so any other
        // error code stays in the address bar. Hoort in stage L16 te veranderen.
        expect(window.location.search).toBe('?error=something_else');
    });
});

describe('an invite-redeem link that could not be redeemed', () => {
    // /auth/redeem-invite/:token 302s here with these two codes when the
    // token itself was unknown/expired, or when the lookup blew up. Before
    // this, both landed on a bare login page with no clue the link did
    // anything at all.
    it('explains an expired or unknown invite token and cleans the URL', async () => {
        window.history.replaceState({}, '', '/?error=invite_expired');
        renderLogin();
        expect(await screen.findByText(/This invitation link has expired or is no longer valid/)).toBeInTheDocument();
        expect(window.location.search).toBe('');
        expect(screen.queryByTestId('signup-wizard')).toBeNull();
    });

    it('explains a failed invite lookup and cleans the URL', async () => {
        window.history.replaceState({}, '', '/?error=invite_error');
        renderLogin();
        expect(await screen.findByText(/Something went wrong opening this invitation/)).toBeInTheDocument();
        expect(window.location.search).toBe('');
    });
});

describe('following an invite', () => {
    it('hands a server-side pending invite straight to the signup wizard', async () => {
        route('/auth/pending-invite', () => ok({
            valid: true, token: 'inv-1', email: 'new@example.com',
            organizationId: 'org-1', orgName: 'Acme',
        }));
        renderLogin();
        expect(await screen.findByTestId('signup-wizard')).toBeInTheDocument();
    });

    it('scrubs a legacy ?invite= token out of the address bar before validating it', async () => {
        route('/auth/invite', () => ok({ valid: true, email: 'new@example.com', organizationId: 'org-1' }));
        window.history.replaceState({}, '', '/?invite=legacy-token');
        renderLogin();
        await screen.findByTestId('signup-wizard');
        expect(window.location.search).toBe('');
        expect(callTo('/auth/invite/legacy-token')).toBeTruthy();
    });

    // wrat: `?invite=` puts the page into signup mode from the very first
    // render, before anything has been validated. A dead link therefore opens
    // the signup wizard anyway and the expiry message is shown INSIDE it, on
    // top of a form the visitor can never submit. Hoort in stage L16 te
    // veranderen (dood invite → terug naar het aanmeldformulier).
    it('opens the signup wizard on a dead invite link and puts the expiry message in it', async () => {
        route('/auth/invite', () => fail(404, { error: 'gone' }));
        window.history.replaceState({}, '', '/?invite=dead-token');
        renderLogin();
        const wizard = await screen.findByTestId('signup-wizard');
        await waitFor(() => expect(wizard).toHaveTextContent('This invitation link has expired or is no longer valid.'));
        expect(screen.queryByTestId('username')).toBeNull();
    });

    // wrat: both invite failure messages are hardcoded English string literals
    // — the only user-facing text on this screen that never goes through t().
    // A Dutch visitor with a dead invite link gets an English sentence. Hoort
    // in stage L16 te veranderen (samen met de i18n-retrofit).
    it('reports a failed invite lookup in untranslated English too', async () => {
        route('/auth/invite', () => Promise.reject(new Error('offline')));
        window.history.replaceState({}, '', '/?invite=dead-token');
        renderLogin();
        const wizard = await screen.findByTestId('signup-wizard');
        await waitFor(() => expect(wizard).toHaveTextContent('Failed to validate invitation. Please try again.'));
    });

    it('opens the signup wizard straight away on a ?signup=1 deep link', async () => {
        window.history.replaceState({}, '', '/?signup=1');
        renderLogin();
        expect(await screen.findByTestId('signup-wizard')).toBeInTheDocument();
    });
});

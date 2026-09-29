import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, fail } from '@/test/http';
import LoginPage from './LoginPage';
import { authFetch } from '../utils/helpers';

/**
 * E2E SELECTOR CONTRACT for the sign-in screen (L0).
 *
 * The Playwright suite logs in through this screen ONCE, in global-setup, and
 * saves the session for every other spec. A renamed test id there is not a test
 * failure — `runner/smoke.mjs` reports it as an INFRA error (exit 3), which
 * reads as "the stack is broken" and costs an afternoon before anyone looks at
 * a frontend diff. This file turns that into a red vitest instead.
 *
 * Consumers of these ids, all of which must keep working:
 *   - e2e/tests/global-setup.ts               username, password, login-submit-button
 *   - e2e/tests/generated/login-navigation.spec.ts   the same three
 *   - playwright-tests/support/login.ts       the same three
 *   - e2e/context/app-map.md                  documents PART of the list
 *
 * Let op de laatste: app-map.md noemt vandaag alleen username, password,
 * login-submit-button, de drie sso-*-knoppen en create-account-button, en zegt
 * er bovendien bij dat de SSO-ids "on the full form only" staan — terwijl deze
 * karakterisatie ze óók op de ingeklapte weergave pint. De overige ids die dit
 * bestand vastlegt (login-other-methods, root-password, confirm-password, de
 * mfa-* en recovery-* ids) staan NERGENS in e2e/ of playwright-tests/. Dit
 * bestand is dus de bredere waarheid; app-map.md loopt achter en ligt buiten
 * het schrijfgebied van de karakterisatie.
 *
 * If a redesign has to rename one, rename it HERE en in de bestanden hierboven
 * die hem echt gebruiken — en werk app-map.md bij in diezelfde wijziging.
 * Do not delete an assertion to make this file pass.
 *
 * The one-time gates that stand AFTER submit are pinned where they live:
 * `encryption-recovery-key` / `encryption-recovery-saved` in
 * EncryptionSetup.test.jsx (the "I've saved my recovery key" gate that
 * global-setup's DISMISS_BUTTONS and playwright-tests/support/gates.ts click
 * through), and the enrollment gate in login/MfaSetupGate.test.jsx.
 */
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(), setSessionToken: vi.fn() }));
vi.mock('../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../lib/opaque', () => ({ opaqueLogin: vi.fn() }));
vi.mock('./login/SignupWizard', () => ({ default: () => <div data-testid="signup-wizard" /> }));
vi.mock('../components/InitSetupWizard', () => ({ default: () => null }));

/** The three ids the Playwright login helpers cannot live without. */
const SIGN_IN_IDS = ['username', 'password', 'login-submit-button'];

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
const isPath = (url, path) => {
    const u = String(url);
    return u === path || u.startsWith(`${path}/`) || u.startsWith(`${path}?`);
};
const route = (path, handler) => routes.unshift([path, handler]);

const dropPreferredCookie = () => {
    document.cookie = 'bf_preferred_login=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
};

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/');
    dropPreferredCookie();
    authFetch.mockReset();
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

afterEach(() => { vi.restoreAllMocks(); dropPreferredCookie(); });

const renderLogin = () => render(<LoginPage onLogin={vi.fn()} />);

describe('the three ids the Playwright login helpers fill and click', () => {
    it.each(SIGN_IN_IDS)('exposes "%s" on a fresh browser', async (id) => {
        renderLogin();
        expect(await screen.findByTestId(id)).toBeInTheDocument();
    });

    it('exposes all three at once, on one form, so a single pass can drive them', async () => {
        const { container } = renderLogin();
        await screen.findByTestId('login-submit-button');
        const form = container.querySelector('form');
        SIGN_IN_IDS.forEach((id) => {
            expect(form.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
        });
    });

    it('keeps the submit id on a real submit button, not on a div', async () => {
        renderLogin();
        const submit = await screen.findByTestId('login-submit-button');
        expect(submit.tagName).toBe('BUTTON');
        expect(submit).toHaveAttribute('type', 'submit');
    });

    // global-setup fills ADMIN_USER, which defaults to the bare name 'admin' on
    // a self-hosted stack. A type="email" input would refuse that at submit
    // time and the suite would time out waiting for a sidebar that never comes.
    it('accepts a bare username, not only an e-mail address', async () => {
        renderLogin();
        const username = await screen.findByTestId('username');
        expect(username).toHaveAttribute('type', 'text');
        fireEvent.change(username, { target: { value: 'admin' } });
        expect(username).toHaveValue('admin');
        expect(username.checkValidity()).toBe(true);
    });

    // A browser that has signed in with a password before gets the collapsed
    // single-method view. app-map.md promises the same three ids there — and
    // that view builds its OWN <form> and its OWN submit button, so the whole
    // contract has to be re-checked here: three ids, one form, and a real
    // type="submit" button. Playwright only clicks the button, so a regression
    // to type="button" would leave a returning browser silently unable to sign
    // in without anything going red.
    it('keeps all three ids — on one form, behind a real submit — in the remembered-password view', async () => {
        document.cookie = 'bf_preferred_login=password;path=/';
        const { container } = renderLogin();
        await screen.findByTestId('login-submit-button');
        // The full form carries the "or continue with" divider and the collapsed
        // view does not, so its absence is the marker that the cookie effect has
        // settled. Waiting on the ids alone would race the swap.
        await waitFor(() => expect(screen.queryByText('login.or_continue_with')).toBeNull());

        SIGN_IN_IDS.forEach((id) => expect(screen.getByTestId(id)).toBeInTheDocument());

        const form = container.querySelector('form');
        SIGN_IN_IDS.forEach((id) => {
            expect(form.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
        });

        const submit = screen.getByTestId('login-submit-button');
        expect(submit.tagName).toBe('BUTTON');
        expect(submit).toHaveAttribute('type', 'submit');
        expect(submit.closest('form')).toBe(form);
    });

    // wrat: a browser that last used an SSO provider has NO password form and
    // therefore none of these three ids. Playwright always starts from a clean
    // context so it never hits this, but anyone debugging the suite in their
    // own browser will. Hoort in stage L2/L3 te veranderen.
    it('has none of the three in a remembered-SSO view', async () => {
        document.cookie = 'bf_preferred_login=google;path=/';
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, isGoogleConfigured: true }));
        renderLogin();
        // `login-other-methods` only exists in the collapsed view, so it is the
        // marker that the cookie effect has settled — the full form renders a
        // Google button too, and waiting on that would race the swap.
        await screen.findByTestId('login-other-methods');
        SIGN_IN_IDS.forEach((id) => expect(screen.queryByTestId(id)).toBeNull());
        expect(screen.getByTestId('sso-google-button')).toBeInTheDocument();
    });
});

describe('de overige ids van dit scherm (deels buiten app-map.md)', () => {
    it('names each configured SSO provider on the full form', async () => {
        route('/auth/setup-status', () => ok({
            ...SETUP_STATUS, isGoogleConfigured: true, isMicrosoftConfigured: true, isOAuthConfigured: true,
        }));
        renderLogin();
        expect(await screen.findByTestId('sso-google-button')).toBeInTheDocument();
        expect(screen.getByTestId('sso-microsoft-button')).toBeInTheDocument();
        expect(screen.getByTestId('sso-nextcloud-button')).toBeInTheDocument();
        expect(screen.getByTestId('create-account-button')).toBeInTheDocument();
    });

    it('uses the same SSO ids in the collapsed single-method view', async () => {
        document.cookie = 'bf_preferred_login=microsoft;path=/';
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, isMicrosoftConfigured: true }));
        renderLogin();
        await screen.findByTestId('login-other-methods');
        expect(screen.getByTestId('sso-microsoft-button')).toBeInTheDocument();
        expect(screen.getByTestId('create-account-button')).toBeInTheDocument();
        expect(screen.queryByTestId('login-submit-button')).toBeNull();
    });

    // On a stack that has never been set up the sign-in ids do not exist at
    // all — the screen asks for a root password instead. global-setup failing
    // here IS the truth (the environment is not ready), so this is pinned to
    // keep that diagnosis honest rather than to be fixed.
    it('offers root-password instead of the sign-in ids before first-run setup', async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, isSetupComplete: false }));
        renderLogin();
        expect(await screen.findByTestId('root-password')).toBeInTheDocument();
        expect(screen.getByTestId('confirm-password')).toBeInTheDocument();
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.queryByTestId('password')).toBeNull();
    });
});

describe('the gates that stand between submit and the app shell', () => {
    it('marks the second-factor prompt with an id global-setup can probe', async () => {
        route('/auth/admin-login', () => ok({ mfaRequired: true }));
        renderLogin();
        await screen.findByTestId('login-submit-button');
        fireEvent.change(screen.getByTestId('username'), { target: { value: 'admin' } });
        fireEvent.change(screen.getByTestId('password'), { target: { value: 'pw' } });
        fireEvent.submit(screen.getByTestId('login-submit-button').closest('form'));
        expect(await screen.findByTestId('mfa-login-step')).toBeInTheDocument();
        expect(screen.getByTestId('mfa-code-input')).toBeInTheDocument();
        expect(screen.getByTestId('mfa-verify-button')).toBeInTheDocument();
    });

    it('marks the recovery-key modal and its only exit', async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, isSetupComplete: false }));
        route('/auth/setup', () => ok({ recoveryKey: 'AAAA-BBBB' }));
        renderLogin();
        await screen.findByTestId('root-password');
        fireEvent.change(screen.getByTestId('root-password'), { target: { value: 'Password1' } });
        fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: 'Password1' } });
        fireEvent.submit(screen.getByTestId('login-submit-button').closest('form'));
        expect(await screen.findByTestId('recovery-key-modal')).toBeInTheDocument();
        expect(screen.getByTestId('recovery-key-value')).toHaveTextContent('AAAA-BBBB');
        expect(screen.getByTestId('recovery-key-saved')).toBeInTheDocument();
    });

    // wrat: the red error block carries no test id and no role, so
    // playwright-tests/support/login.ts can only recognise a rejected login by
    // matching English prose (/login failed|invalid (email|credentials)|incorrect password/i). Half of
    // that prose comes from the server and half from the i18n dictionary, so a
    // translated stack turns a rejected login into a 60-second timeout with a
    // misleading message. Hoort in stage L16 te veranderen.
    it('gives a failed sign-in no id and no role at all', async () => {
        route('/auth/admin-login', () => fail(401, { error: 'Invalid credentials' }));
        const { container } = renderLogin();
        await screen.findByTestId('login-submit-button');
        fireEvent.change(screen.getByTestId('username'), { target: { value: 'admin' } });
        fireEvent.change(screen.getByTestId('password'), { target: { value: 'nope' } });
        fireEvent.submit(screen.getByTestId('login-submit-button').closest('form'));
        await screen.findByText('Invalid credentials');
        expect(container.querySelector('[data-testid="login-error"]')).toBeNull();
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it('leaves the sign-in ids on screen after a rejection, which is how the helpers poll', async () => {
        route('/auth/admin-login', () => fail(401, { error: 'Invalid credentials' }));
        renderLogin();
        await screen.findByTestId('login-submit-button');
        fireEvent.change(screen.getByTestId('username'), { target: { value: 'admin' } });
        fireEvent.change(screen.getByTestId('password'), { target: { value: 'nope' } });
        fireEvent.submit(screen.getByTestId('login-submit-button').closest('form'));
        await screen.findByText('Invalid credentials');
        await waitFor(() => expect(screen.getByTestId('login-submit-button')).not.toBeDisabled());
        SIGN_IN_IDS.forEach((id) => expect(screen.getByTestId(id)).toBeInTheDocument());
    });
});

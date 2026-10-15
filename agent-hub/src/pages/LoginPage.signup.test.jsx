import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, fail } from '@/test/http';
import LoginPage from './LoginPage';
import { authFetch } from '../utils/helpers';

/**
 * CHARACTERISATION — the signup submit, the plan list, the verification
 * gate's e-mail field and the OAuth popup, exactly as LoginPage does them
 * today. The wizard is a stub that hands its props to the test, so the
 * handlers LoginPage owns (handleSignup, resetSignup, ...) run for real.
 */
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(), setSessionToken: vi.fn() }));
vi.mock('../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../lib/opaque', () => ({ opaqueLogin: vi.fn() }));
vi.mock('../components/InitSetupWizard', () => ({ default: () => null }));

const wizard = vi.hoisted(() => ({ props: null }));
vi.mock('./login/SignupWizard', () => ({
    default: (props) => {
        wizard.props = props;
        return (
            <div data-testid="signup-wizard">
                <span data-testid="wizard-error">{props.error}</span>
                <span data-testid="wizard-plans">{props.availablePlans.map(p => p.id).join(',')}</span>
                <span data-testid="wizard-selected">{String(props.selectedPlanId)}</span>
                <span data-testid="wizard-type">{props.signupData.signupType}</span>
            </div>
        );
    },
}));

const SETUP_STATUS = { isSetupComplete: true, allowSignups: true, allowPasswordLogin: true, deploymentMode: 'cloud' };
let routes;
const isPath = (url, path) => { const u = String(url); return u === path || u.startsWith(`${path}/`) || u.startsWith(`${path}?`); };
const route = (path, handler) => routes.unshift([path, handler]);
const callTo = (path) => authFetch.mock.calls.find(([u]) => isPath(u, path));
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/?signup=1');
    authFetch.mockReset();
    routes = [
        ['/auth/setup-status', () => ok({ ...SETUP_STATUS })],
        ['/auth/organizations/public', () => ok([])],
        ['/auth/pending-invite', () => ok({ valid: false })],
        ['/billing/public-plans', () => ok({ plans: [
            { id: 'org-1', name: 'Org', price: 10, planType: 'organization' },
            { id: 'con-1', name: 'Me', price: 5, planType: 'consumer' },
        ] })],
    ];
    authFetch.mockImplementation((url, options) => {
        const hit = routes.find(([path]) => isPath(String(url), path));
        return hit ? hit[1](options, String(url)) : fail(404, { error: 'unrouted' });
    });
});
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

async function renderWizard() {
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    await screen.findByTestId('signup-wizard');
    return onLogin;
}

const fill = (patch) => act(() => { wizard.props.setSignupData(prev => ({ ...prev, ...patch })); });
const validAccount = { username: 'ada', password: 'Tr0ub4dor&3xyz', confirmPassword: 'Tr0ub4dor&3xyz', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };
const submit = () => act(async () => { await wizard.props.handleSignup({ preventDefault() {} }); });

describe('plans offered during signup', () => {
    it('fetches the public plans and offers those of the chosen account type', async () => {
        window.history.replaceState({}, '', '/?signup=1&type=consumer&plan=con-1');
        await renderWizard();
        await waitFor(() => expect(screen.getByTestId('wizard-plans')).toHaveTextContent('con-1'));
        expect(screen.getByTestId('wizard-plans')).not.toHaveTextContent('org-1');
        expect(screen.getByTestId('wizard-selected')).toHaveTextContent('con-1');
    });

    it('drops a ?plan= id that the account type cannot buy', async () => {
        window.history.replaceState({}, '', '/?signup=1&plan=con-1');
        await renderWizard();
        await waitFor(() => expect(screen.getByTestId('wizard-plans')).toHaveTextContent('org-1'));
        expect(screen.getByTestId('wizard-selected')).toHaveTextContent('null');
    });
});

describe('submitting the signup', () => {
    it('refuses a mismatched password pair without a request', async () => {
        await renderWizard();
        await fill({ ...validAccount, confirmPassword: 'other' });
        await submit();
        expect(screen.getByTestId('wizard-error')).toHaveTextContent('login.passwords_no_match');
        expect(callTo('/auth/signup')).toBeUndefined();
    });

    it('refuses what the shared validation refuses', async () => {
        await renderWizard();
        await fill({ ...validAccount, username: '' });
        await submit();
        expect(screen.getByTestId('wizard-error')).toHaveTextContent('Please choose a username.');
        expect(callTo('/auth/signup')).toBeUndefined();
    });

    it('wants the captcha token when the operator configured a provider', async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, signupCaptcha: { enabled: true } }));
        await renderWizard();
        await fill({ ...validAccount, signupType: 'consumer' });
        await waitFor(() => expect(wizard.props.captchaConfig).toEqual({ enabled: true }));
        await submit();
        expect(screen.getByTestId('wizard-error')).toHaveTextContent('Please complete the verification challenge.');
        expect(callTo('/auth/signup')).toBeUndefined();
    });

    it('posts a personal account with its privacy choices and the captcha token', async () => {
        route('/auth/setup-status', () => ok({ ...SETUP_STATUS, signupCaptcha: { enabled: true } }));
        route('/auth/signup', () => ok({ success: true, user: { id: 'u1' }, recoveryKey: 'RK' }));
        const onLogin = await renderWizard();
        await fill({ ...validAccount, signupType: 'consumer' });
        await waitFor(() => expect(wizard.props.captchaConfig).toBeTruthy());
        act(() => wizard.props.onCaptchaToken('cap-tok'));
        await submit();
        const body = bodyOf(callTo('/auth/signup'));
        expect(body).toMatchObject({
            username: 'ada', password: validAccount.password, displayName: 'Ada Lovelace',
            email: 'ada@example.com', locale: 'en', selectedPlanId: null, captchaToken: 'cap-tok',
            privacyShield: { enabled: true, piiDetectionAction: 'block', euModeEnabled: false },
        });
        expect(body.newOrgName).toBeUndefined();
        expect(onLogin).toHaveBeenCalledWith({ id: 'u1' }, 'RK');
    });

    it('posts a new organisation with its details', async () => {
        route('/auth/signup', () => ok({ success: true, user: { id: 'u2' } }));
        const onLogin = await renderWizard();
        await fill({ ...validAccount, signupType: 'new', newOrgName: 'Acme', orgKvk: '12345678', orgVat: 'NL123456789B01', orgTagline: 'tag' });
        await submit();
        const body = bodyOf(callTo('/auth/signup'));
        expect(body.newOrgName).toBe('Acme');
        expect(body.orgDetails).toMatchObject({ tagline: 'tag', kvk: '12345678', vat: 'NL123456789B01', allowSignup: false });
        expect(body.orgDetails.privacyShield.enabled).toBe(true);
        expect(body.captchaToken).toBeUndefined();
        expect(onLogin).toHaveBeenCalledWith({ id: 'u2' }, undefined);
    });

    it('joins an existing organisation by id', async () => {
        route('/auth/signup', () => ok({ success: true, user: { id: 'u3' } }));
        await renderWizard();
        await fill({ ...validAccount, signupType: 'existing', organizationId: 'org-9' });
        await submit();
        expect(bodyOf(callTo('/auth/signup')).organizationId).toBe('org-9');
    });

    it('carries the invite token and signs up as a member of the inviting org', async () => {
        window.history.replaceState({}, '', '/');
        route('/auth/pending-invite', () => ok({ valid: true, token: 'inv-1', organizationId: 'org-7', orgName: 'Acme', email: 'ada@example.com' }));
        route('/auth/signup', () => ok({ success: true, user: { id: 'u4' } }));
        await renderWizard();
        await waitFor(() => expect(screen.getByTestId('wizard-type')).toHaveTextContent('existing'));
        await fill({ username: 'ada', password: validAccount.password, confirmPassword: validAccount.password });
        await submit();
        const body = bodyOf(callTo('/auth/signup'));
        expect(body).toMatchObject({ inviteToken: 'inv-1', organizationId: 'org-7', email: 'ada@example.com' });
    });

    it('shows the "check your inbox" gate when the account needs confirming', async () => {
        route('/auth/signup', () => ok({ emailVerificationRequired: true }));
        await renderWizard();
        await fill({ ...validAccount, signupType: 'existing', organizationId: 'o' });
        await submit();
        expect(await screen.findByText('We sent a confirmation link to')).toBeInTheDocument();
        expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    });

    it('shows the server complaint, or its own wording, when the signup is refused', async () => {
        route('/auth/signup', () => fail(400, { error: 'Username taken' }));
        await renderWizard();
        await fill({ ...validAccount, signupType: 'existing', organizationId: 'o' });
        await submit();
        expect(screen.getByTestId('wizard-error')).toHaveTextContent('Username taken');
        route('/auth/signup', () => fail(400, {}));
        await submit();
        expect(screen.getByTestId('wizard-error')).toHaveTextContent('login.signup_failed');
    });

    it('reports a connection error in untranslated English', async () => {
        route('/auth/signup', () => Promise.reject(new Error('down')));
        await renderWizard();
        await fill({ ...validAccount, signupType: 'existing', organizationId: 'o' });
        await submit();
        expect(screen.getByTestId('wizard-error')).toHaveTextContent('Connection error. Please try again.');
    });

    it('resetSignup leaves the wizard and wipes what was typed', async () => {
        await renderWizard();
        await fill({ ...validAccount, signupType: 'consumer' });
        act(() => wizard.props.resetSignup());
        await waitFor(() => expect(screen.queryByTestId('signup-wizard')).toBeNull());
        await userEvent.click(await screen.findByTestId('create-account-button'));
        await screen.findByTestId('signup-wizard');
        expect(wizard.props.signupData.username).toBe('');
        expect(wizard.props.signupData.signupType).toBe('new');
        expect(wizard.props.signupData.password).toBe('');
    });
});

describe('the verification gate without a known address', () => {
    it('asks for an address, resends to it, and trims it', async () => {
        route('/auth/signup', () => ok({ emailVerificationRequired: true }));
        route('/auth/resend-verification', () => ok({}));
        await renderWizard();
        await fill({ ...validAccount, email: '', signupType: 'existing', organizationId: 'o' });
        await submit();
        const input = await screen.findByPlaceholderText('you@example.com');
        await userEvent.click(input);
        await userEvent.paste('  ada@example.com ');
        await userEvent.click(screen.getByText('Resend confirmation email'));
        await waitFor(() => expect(callTo('/auth/resend-verification')).toBeTruthy());
        expect(bodyOf(callTo('/auth/resend-verification'))).toEqual({ email: 'ada@example.com' });
    });
});

describe('the OAuth popup inside an iframe', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

    it('opens a noopener popup with a pickup id and signs in when the pickup answers', async () => {
        window.history.replaceState({}, '', '/');
        vi.resetModules();
        Object.defineProperty(window, 'self', { value: {}, configurable: true });
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const { default: Page } = await import('./LoginPage');
        const helpers = await import('../utils/helpers');
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ sessionToken: 'tok-1' }) }));
        vi.stubGlobal('fetch', fetchMock);
        helpers.authFetch.mockImplementation((url) => {
            const u = String(url);
            if (u.startsWith('/auth/setup-status')) return ok({ ...SETUP_STATUS, isGoogleConfigured: true });
            if (u.startsWith('/auth/user')) return ok({ authenticated: true, user: { id: 'sso' } });
            if (u.startsWith('/auth/organizations')) return ok([]);
            return ok({ valid: false });
        });
        const onLogin = vi.fn();
        render(<Page onLogin={onLogin} />);
        const btn = await screen.findByTestId('sso-google-button');
        vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval'] });
        btn.click();
        expect(open).toHaveBeenCalledTimes(1);
        const [url, name, features] = open.mock.calls[0];
        expect(url).toMatch(/^\/auth\/login\/google\?popup=1&pickup=/);
        expect(name).toBe('beeflow_oauth');
        expect(features).toContain('noopener,noreferrer');
        await vi.advanceTimersByTimeAsync(1600);
        expect(fetchMock.mock.calls[0][0]).toMatch(/^\/auth\/login-pickup\?id=/);
        expect(helpers.setSessionToken).toHaveBeenCalledWith('tok-1');
        expect(onLogin).toHaveBeenCalledWith({ id: 'sso' });
        delete window.self;
    });
});

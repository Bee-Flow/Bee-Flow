import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FormEvent } from 'react';
import { ok, fail } from '@/test/http';
import LoginPage from './LoginPage';
import type { SignupData } from './login/signupValidation';

/**
 * CHARACTERISATION: the signup submit, the plan list, the verification
 * gate's e-mail field and the OAuth popup, exactly as LoginPage does them
 * today. The wizard is a stub that hands its props to the test, so the
 * handlers LoginPage owns (handleSignup, resetSignup, ...) run for real.
 */
interface WizardProps {
    error: string;
    availablePlans: { id: string }[];
    selectedPlanId: string | null;
    signupData: SignupData;
    captchaConfig: { enabled?: boolean } | null;
    setSignupData: (update: (prev: SignupData) => SignupData) => void;
    onCaptchaToken: (token: string) => void;
    handleSignup: (e: FormEvent) => Promise<void>;
    resetSignup: () => void;
}
type Reply = Promise<unknown>;
type Handler = (options: { body: string }) => Reply;

const h = vi.hoisted(() => ({
    authFetch: vi.fn(),
    setSessionToken: vi.fn(),
    wizard: { props: null as WizardProps | null },
}));
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: h.authFetch, setSessionToken: h.setSessionToken }));
vi.mock('../hooks/useTranslation', () => import('@/test/useTranslationMock'));
vi.mock('../lib/opaque', () => ({ opaqueLogin: vi.fn() }));
vi.mock('../components/InitSetupWizard', () => ({ default: () => null }));
vi.mock('./login/SignupWizard', () => ({
    default: (props: WizardProps) => {
        h.wizard.props = props;
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

const wp = (): WizardProps => {
    if (!h.wizard.props) throw new Error('the wizard has not rendered');
    return h.wizard.props;
};
const SETUP_STATUS = { isSetupComplete: true, allowSignups: true, allowPasswordLogin: true, deploymentMode: 'cloud' };
const CAPTCHA_STATUS = { ...SETUP_STATUS, signupCaptcha: { enabled: true } };
const PLANS = { plans: [
    { id: 'org-1', name: 'Org', price: 10, planType: 'organization' },
    { id: 'con-1', name: 'Me', price: 5, planType: 'consumer' },
] };
const ACCOUNT = { username: 'ada', password: 'Tr0ub4dor&3xyz', confirmPassword: 'Tr0ub4dor&3xyz', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };
const EXISTING = { ...ACCOUNT, signupType: 'existing', organizationId: 'o' };

let routes: [string, Handler][];
const isPath = (url: string, path: string) => url === path || url.startsWith(`${path}/`) || url.startsWith(`${path}?`);
const route = (path: string, handler: Handler) => routes.unshift([path, handler]);
const reply = (path: string, body: unknown) => route(path, () => ok(body));
const callTo = (path: string) => h.authFetch.mock.calls.find(([u]) => isPath(String(u), path));
const bodyTo = (path: string) => JSON.parse(callTo(path)?.[1].body);

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/?signup=1');
    h.authFetch.mockReset();
    routes = [
        ['/auth/setup-status', () => ok(SETUP_STATUS)],
        ['/auth/organizations/public', () => ok([])],
        ['/auth/pending-invite', () => ok({ valid: false })],
        ['/billing/public-plans', () => ok(PLANS)],
    ];
    h.authFetch.mockImplementation((url, options) => {
        const hit = routes.find(([path]) => isPath(String(url), path));
        return hit ? hit[1](options) : fail(404, { error: 'unrouted' });
    });
});
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

async function renderWizard() {
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    await screen.findByTestId('signup-wizard');
    return onLogin;
}
const fill = (patch: Partial<SignupData>) => act(() => { wp().setSignupData(prev => ({ ...prev, ...patch })); });
const submit = () => act(async () => { await wp().handleSignup({ preventDefault() {} } as FormEvent); });
const expectError = (text: string) => expect(screen.getByTestId('wizard-error')).toHaveTextContent(text);
/** Open the wizard, fill the form and press submit. */
async function signUpWith(patch: Partial<SignupData>) {
    const onLogin = await renderWizard();
    await fill(patch);
    await submit();
    return onLogin;
}

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
        await signUpWith({ ...ACCOUNT, confirmPassword: 'other' });
        expectError('login.passwords_no_match');
        expect(callTo('/auth/signup')).toBeUndefined();
    });

    it('refuses what the shared validation refuses', async () => {
        await signUpWith({ ...ACCOUNT, username: '' });
        expectError('Please choose a username.');
        expect(callTo('/auth/signup')).toBeUndefined();
    });

    it('wants the captcha token when the operator configured a provider', async () => {
        reply('/auth/setup-status', CAPTCHA_STATUS);
        await renderWizard();
        await fill({ ...ACCOUNT, signupType: 'consumer' });
        await waitFor(() => expect(wp().captchaConfig).toEqual({ enabled: true }));
        await submit();
        expectError('Please complete the verification challenge.');
        expect(callTo('/auth/signup')).toBeUndefined();
    });

    it('posts a personal account with its privacy choices and the captcha token', async () => {
        reply('/auth/setup-status', CAPTCHA_STATUS);
        reply('/auth/signup', { success: true, user: { id: 'u1' }, recoveryKey: 'RK' });
        const onLogin = await renderWizard();
        await fill({ ...ACCOUNT, signupType: 'consumer' });
        await waitFor(() => expect(wp().captchaConfig).toBeTruthy());
        act(() => wp().onCaptchaToken('cap-tok'));
        await submit();
        const body = bodyTo('/auth/signup');
        expect(body).toMatchObject({
            username: 'ada', password: ACCOUNT.password, displayName: 'Ada Lovelace',
            email: 'ada@example.com', locale: 'en', selectedPlanId: null, captchaToken: 'cap-tok',
            privacyShield: { enabled: true, piiDetectionAction: 'block', euModeEnabled: false },
        });
        expect(body.newOrgName).toBeUndefined();
        expect(onLogin).toHaveBeenCalledWith({ id: 'u1' }, 'RK');
    });

    it('posts a new organisation with its details', async () => {
        reply('/auth/signup', { success: true, user: { id: 'u2' } });
        const onLogin = await signUpWith({ ...ACCOUNT, signupType: 'new', newOrgName: 'Acme', orgKvk: '12345678', orgVat: 'NL123456789B01', orgTagline: 'tag' });
        const body = bodyTo('/auth/signup');
        expect(body.newOrgName).toBe('Acme');
        expect(body.orgDetails).toMatchObject({ tagline: 'tag', kvk: '12345678', vat: 'NL123456789B01', allowSignup: false });
        expect(body.orgDetails.privacyShield.enabled).toBe(true);
        expect(body.captchaToken).toBeUndefined();
        expect(onLogin).toHaveBeenCalledWith({ id: 'u2' }, undefined);
    });

    it('joins an existing organisation by id', async () => {
        reply('/auth/signup', { success: true, user: { id: 'u3' } });
        await signUpWith({ ...ACCOUNT, signupType: 'existing', organizationId: 'org-9' });
        expect(bodyTo('/auth/signup').organizationId).toBe('org-9');
    });

    it('carries the invite token and signs up as a member of the inviting org', async () => {
        window.history.replaceState({}, '', '/');
        reply('/auth/pending-invite', { valid: true, token: 'inv-1', organizationId: 'org-7', orgName: 'Acme', email: 'ada@example.com' });
        reply('/auth/signup', { success: true, user: { id: 'u4' } });
        await renderWizard();
        await waitFor(() => expect(screen.getByTestId('wizard-type')).toHaveTextContent('existing'));
        await fill({ username: 'ada', password: ACCOUNT.password, confirmPassword: ACCOUNT.password });
        await submit();
        expect(bodyTo('/auth/signup')).toMatchObject({ inviteToken: 'inv-1', organizationId: 'org-7', email: 'ada@example.com' });
    });

    it('shows the "check your inbox" gate when the account needs confirming', async () => {
        reply('/auth/signup', { emailVerificationRequired: true });
        await signUpWith(EXISTING);
        expect(await screen.findByText('We sent a confirmation link to')).toBeInTheDocument();
        expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    });

    it('shows the server complaint, or its own wording, when the signup is refused', async () => {
        route('/auth/signup', () => fail(400, { error: 'Username taken' }));
        await signUpWith(EXISTING);
        expectError('Username taken');
        route('/auth/signup', () => fail(400, {}));
        await submit();
        expectError('login.signup_failed');
    });

    it('reports a connection error in untranslated English', async () => {
        route('/auth/signup', () => Promise.reject(new Error('down')));
        await signUpWith(EXISTING);
        expectError('Connection error. Please try again.');
    });

    it('resetSignup leaves the wizard and wipes what was typed', async () => {
        await renderWizard();
        await fill({ ...ACCOUNT, signupType: 'consumer' });
        act(() => wp().resetSignup());
        await waitFor(() => expect(screen.queryByTestId('signup-wizard')).toBeNull());
        await userEvent.click(await screen.findByTestId('create-account-button'));
        await screen.findByTestId('signup-wizard');
        expect(wp().signupData).toMatchObject({ username: '', password: '', signupType: 'new' });
    });
});

describe('the verification gate without a known address', () => {
    it('asks for an address, resends to it, and trims it', async () => {
        reply('/auth/signup', { emailVerificationRequired: true });
        reply('/auth/resend-verification', {});
        await signUpWith({ ...EXISTING, email: '' });
        await userEvent.click(await screen.findByPlaceholderText('you@example.com'));
        await userEvent.paste('  ada@example.com ');
        await userEvent.click(screen.getByText('Resend confirmation email'));
        await waitFor(() => expect(callTo('/auth/resend-verification')).toBeTruthy());
        expect(bodyTo('/auth/resend-verification')).toEqual({ email: 'ada@example.com' });
    });
});

describe('the OAuth popup inside an iframe', () => {
    const originalSelf = Object.getOwnPropertyDescriptor(window, 'self');
    afterEach(() => {
        vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules();
        if (originalSelf) Object.defineProperty(window, 'self', originalSelf);
        else Reflect.deleteProperty(window, 'self');
    });

    it('opens a noopener popup with a pickup id and signs in when the pickup answers', async () => {
        window.history.replaceState({}, '', '/');
        vi.resetModules();
        Object.defineProperty(window, 'self', { value: {}, configurable: true });
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const { default: Page } = await import('./LoginPage');
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ sessionToken: 'tok-1' }) }));
        vi.stubGlobal('fetch', fetchMock);
        reply('/auth/setup-status', { ...SETUP_STATUS, isGoogleConfigured: true });
        reply('/auth/user', { authenticated: true, user: { id: 'sso' } });
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
        expect(fetchMock.mock.calls[0]).toEqual([expect.stringMatching(/^\/auth\/login-pickup\?id=/), { credentials: 'include' }]);
        expect(h.setSessionToken).toHaveBeenCalledWith('tok-1');
        expect(onLogin).toHaveBeenCalledWith({ id: 'sso' });
    });
});

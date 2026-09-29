import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LoginForm from './LoginForm';

/**
 * CHARACTERISATION — the sign-in form exactly as it behaves today (L0).
 *
 * This is the safety net for the L-track redesign, not a wish list: every
 * assertion below pins CURRENT behaviour, warts included, so L1/L2/L3/L12/L16
 * have to say out loud which of these promises they are breaking.
 *
 * LoginForm is a pure props surface — LoginPage owns every request — so the
 * only things this file can pin are: which controls exist, which method is
 * offered when, and the one piece of state the form owns itself (the
 * `bf_preferred_login` cookie that produces the "dedicated" single-method view).
 *
 * The i18n dictionaries belong to another track and are being rewritten, so
 * `t()` is stubbed to return the string fallback when the source passes one and
 * the bare key otherwise. That makes these tests assert WHICH text is shown,
 * not how it happens to be translated this week.
 */
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

function props(overrides = {}) {
    return {
        username: '', setUsername: vi.fn(),
        password: '', setPassword: vi.fn(),
        confirmPassword: '', setConfirmPassword: vi.fn(),
        setupMode: false,
        isLoading: false,
        handleSubmit: vi.fn((e) => e?.preventDefault?.()),
        handleOAuthLogin: vi.fn(),
        handleGoogleLogin: vi.fn(),
        handleMicrosoftLogin: vi.fn(),
        isOAuthConfigured: false,
        isGoogleConfigured: false,
        isMicrosoftConfigured: false,
        setSignupMode: vi.fn(),
        setError: vi.fn(),
        onForgotPassword: vi.fn(),
        allowSignups: true,
        allowPasswordLogin: true,
        inputClass: 'input', labelClass: 'label',
        ...overrides,
    };
}

function renderForm(overrides = {}) {
    const p = props(overrides);
    return { ...render(<LoginForm {...p} />), p };
}

const dropPreferredCookie = () => {
    document.cookie = 'bf_preferred_login=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
};

beforeEach(dropPreferredCookie);

describe('what the form offers on a first visit', () => {
    it('asks for an email address and a password and offers to sign in', () => {
        renderForm();
        expect(screen.getByTestId('username')).toBeInTheDocument();
        expect(screen.getByTestId('password')).toBeInTheDocument();
        expect(screen.getByTestId('login-submit-button')).toBeInTheDocument();
    });

    it('marks both credential fields required so the browser blocks an empty submit', () => {
        renderForm();
        expect(screen.getByTestId('username')).toBeRequired();
        expect(screen.getByTestId('password')).toBeRequired();
    });

    it('keeps the password masked until the eye is pressed', () => {
        renderForm();
        expect(screen.getByTestId('password')).toHaveAttribute('type', 'password');
        // wrat: the toggle's aria-label is the same hardcoded English string in
        // both states ("Toggle password visibility"), so a screen reader never
        // hears whether the password is currently visible, and a Dutch user
        // never hears Dutch. Hoort in stage L12 te veranderen.
        fireEvent.click(screen.getByLabelText('Toggle password visibility'));
        expect(screen.getByTestId('password')).toHaveAttribute('type', 'text');
    });

    it('offers the forgotten-password way out', () => {
        const { p } = renderForm();
        fireEvent.click(screen.getByText('Forgot password?'));
        expect(p.onForgotPassword).toHaveBeenCalled();
    });

    it('shows only the sign-in methods the server reported as configured', () => {
        const { unmount } = renderForm({ isGoogleConfigured: true });
        expect(screen.getByTestId('sso-google-button')).toBeInTheDocument();
        expect(screen.queryByTestId('sso-microsoft-button')).toBeNull();
        expect(screen.queryByTestId('sso-nextcloud-button')).toBeNull();
        // Ook de omgekeerde kant, per knop: zonder de vlag hoort Google weg te
        // blijven. Een test die alleen de AAN-stand van Google toont, laat een
        // altijd-zichtbare Google-knop ongemerkt door.
        unmount();
        renderForm({ isMicrosoftConfigured: true });
        expect(screen.getByTestId('sso-microsoft-button')).toBeInTheDocument();
        expect(screen.queryByTestId('sso-google-button')).toBeNull();
        expect(screen.queryByTestId('sso-nextcloud-button')).toBeNull();
    });

    it('drops the password form entirely on an SSO-only server', () => {
        renderForm({ allowPasswordLogin: false, isMicrosoftConfigured: true });
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.queryByTestId('password')).toBeNull();
        expect(screen.queryByTestId('login-submit-button')).toBeNull();
        expect(screen.getByTestId('sso-microsoft-button')).toBeInTheDocument();
    });

    it('hides the create-account button when the server closed signups', () => {
        renderForm({ allowSignups: false });
        expect(screen.queryByTestId('create-account-button')).toBeNull();
    });

    it('hides the create-account button when no signup handler was passed', () => {
        // LoginPage passes `setSignupMode={allowSignups ? setSignupMode : null}`,
        // so this is the second, independent lock on the same button.
        renderForm({ setSignupMode: null });
        expect(screen.queryByTestId('create-account-button')).toBeNull();
    });
});

describe('what the form remembers about you', () => {
    it('records "password" as the preferred method on every submit', () => {
        const { container, p } = renderForm();
        fireEvent.submit(container.querySelector('form'));
        expect(p.handleSubmit).toHaveBeenCalled();
        expect(document.cookie).toContain('bf_preferred_login=password');
    });

    it('does not submit — or remember anything — while the fields are still empty', () => {
        // Both credential fields are `required`, so the browser's own
        // constraint validation stops the click before onSubmit ever runs.
        const { p } = renderForm();
        fireEvent.click(screen.getByTestId('login-submit-button'));
        expect(p.handleSubmit).not.toHaveBeenCalled();
        expect(document.cookie).not.toContain('bf_preferred_login');
    });

    // wrat: the cookie is written on CLICK, before anything has succeeded. One
    // stray click on "Sign in with Google" — cancelled at the consent screen,
    // or fired by a mis-tap — pins this browser to a Google-only login screen
    // on the next visit. Hoort in stage L2/L3 te veranderen.
    it('records a provider as preferred the moment its button is clicked, success or not', () => {
        const { p } = renderForm({ isGoogleConfigured: true });
        fireEvent.click(screen.getByTestId('sso-google-button'));
        expect(p.handleGoogleLogin).toHaveBeenCalled();
        expect(document.cookie).toContain('bf_preferred_login=google');
    });

    it('collapses to a single-method view for the remembered provider', () => {
        document.cookie = 'bf_preferred_login=google;path=/';
        renderForm({ isGoogleConfigured: true });
        expect(screen.getByTestId('sso-google-button')).toBeInTheDocument();
        // Everything else is gone — including the password form.
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.queryByTestId('password')).toBeNull();
    });

    it('keeps the password form as the single method when password was remembered', () => {
        document.cookie = 'bf_preferred_login=password;path=/';
        renderForm({ isGoogleConfigured: true });
        expect(screen.getByTestId('username')).toBeInTheDocument();
        expect(screen.getByTestId('password')).toBeInTheDocument();
        expect(screen.getByTestId('login-submit-button')).toBeInTheDocument();
        expect(screen.queryByTestId('sso-google-button')).toBeNull();
    });

    // De ingeklapte weergave rendert een EIGEN create-account-knop, met een
    // eigen `allowSignups && setSignupMode`-poort; het volledige formulier heeft
    // verderop een tweede. Beide staan hier gepind — een test die alleen het
    // volledige formulier afdekt, laat een server met gesloten aanmeldingen in
    // de ingeklapte weergave alsnog een aanmeldknop tonen.
    it('applies both signup locks in the single-method view as well', () => {
        document.cookie = 'bf_preferred_login=password;path=/';

        // Eerst de AAN-stand, zodat "weg" straks niet gewoon "deze weergave
        // heeft die knop sowieso niet" betekent. De ontbrekende scheidingslijn
        // bewijst dat dit de ingeklapte weergave is en niet het volle formulier.
        const open = renderForm();
        expect(screen.getByTestId('create-account-button')).toBeInTheDocument();
        expect(screen.queryByText('login.or_continue_with')).toBeNull();
        open.unmount();

        const closed = renderForm({ allowSignups: false });
        expect(screen.queryByTestId('create-account-button')).toBeNull();
        expect(screen.queryByText('login.or_continue_with')).toBeNull();
        expect(screen.getByTestId('login-submit-button')).toBeInTheDocument();
        closed.unmount();

        // Tweede, onafhankelijke slot op dezelfde knop — LoginPage geeft
        // `setSignupMode={allowSignups ? setSignupMode : null}` door.
        renderForm({ setSignupMode: null });
        expect(screen.queryByTestId('create-account-button')).toBeNull();
        expect(screen.queryByText('login.or_continue_with')).toBeNull();
    });

    it('opens the full list again from "other methods"', () => {
        document.cookie = 'bf_preferred_login=google;path=/';
        renderForm({ isGoogleConfigured: true });
        fireEvent.click(screen.getByTestId('login-other-methods'));
        expect(screen.getByTestId('username')).toBeInTheDocument();
        expect(screen.getByTestId('sso-google-button')).toBeInTheDocument();
    });

    it('does not offer "other methods" when there is nothing else to offer', () => {
        document.cookie = 'bf_preferred_login=password;path=/';
        renderForm({ allowPasswordLogin: true });
        expect(screen.queryByTestId('login-other-methods')).toBeNull();
    });

    it('falls back to the full list when the remembered provider is no longer configured', () => {
        document.cookie = 'bf_preferred_login=google;path=/';
        renderForm({ isGoogleConfigured: false });
        expect(screen.getByTestId('username')).toBeInTheDocument();
        expect(screen.getByTestId('login-submit-button')).toBeInTheDocument();
    });

    // wrat: the dedicated view drops the "or continue with" divider AND every
    // other provider button, so a shared machine shows one person's provider to
    // the next person with no visible hint that anything is hidden apart from a
    // grey "other methods" line. Hoort in stage L2/L3 te veranderen.
    it('hides the divider and the other providers in the dedicated view', () => {
        document.cookie = 'bf_preferred_login=microsoft;path=/';
        renderForm({ isMicrosoftConfigured: true, isGoogleConfigured: true, isOAuthConfigured: true });
        expect(screen.queryByText('login.or_continue_with')).toBeNull();
        expect(screen.queryByTestId('sso-google-button')).toBeNull();
        expect(screen.queryByTestId('sso-nextcloud-button')).toBeNull();
    });
});

describe('the first-run root-password form', () => {
    it('asks for a root password twice and never for a username', () => {
        renderForm({ setupMode: true });
        expect(screen.queryByTestId('username')).toBeNull();
        expect(screen.getByTestId('root-password')).toBeInTheDocument();
        expect(screen.getByTestId('confirm-password')).toBeInTheDocument();
    });

    it('demands at least eight characters for both root fields', () => {
        renderForm({ setupMode: true });
        expect(screen.getByTestId('root-password')).toHaveAttribute('minlength', '8');
        expect(screen.getByTestId('confirm-password')).toHaveAttribute('minlength', '8');
    });

    it('states the password rules under the first field', () => {
        renderForm({ setupMode: true });
        expect(screen.getByText('login.password_requirements')).toBeInTheDocument();
    });

    it('replaces the sign-in label with "initialise" and offers no SSO or signup', () => {
        renderForm({ setupMode: true, isGoogleConfigured: true, isOAuthConfigured: true });
        expect(screen.getByTestId('login-submit-button')).toHaveAttribute('aria-label', 'login.initialize_system');
        expect(screen.queryByTestId('sso-google-button')).toBeNull();
        expect(screen.queryByTestId('create-account-button')).toBeNull();
        expect(screen.queryByText('Forgot password?')).toBeNull();
    });

    // wrat: the setup form renders even when the server says password login is
    // disabled — the branch is `(setupMode || allowPasswordLogin)`. On an
    // SSO-only server the very first screen therefore still mints a password
    // account. Hoort in stage L2 te veranderen.
    it('still shows the root-password form on a server with password login disabled', () => {
        renderForm({ setupMode: true, allowPasswordLogin: false });
        expect(screen.getByTestId('root-password')).toBeInTheDocument();
    });

    // wrat: `bf_preferred_login=password` is written by the setup submit too,
    // because setup reuses the login submit handler. The operator's very first
    // action pins the browser to a dedicated password view. Hoort in stage L2
    // te veranderen.
    it('writes the preferred-method cookie on the setup submit as well', () => {
        const { container } = renderForm({ setupMode: true });
        fireEvent.submit(container.querySelector('form'));
        expect(document.cookie).toContain('bf_preferred_login=password');
    });

    // Not a wart, a guard rail: setupMode wins over the remembered method, so
    // the single-method view can never hide the first-run form. Pinned so a
    // redesign of the dedicated view cannot lose it by accident.
    it('ignores a remembered method while setup is still pending', () => {
        document.cookie = 'bf_preferred_login=google;path=/';
        renderForm({ setupMode: true, isGoogleConfigured: true });
        expect(screen.getByTestId('root-password')).toBeInTheDocument();
        expect(screen.queryByTestId('sso-google-button')).toBeNull();
    });
});

describe('the shape of the login form itself', () => {
    it('is one <form> so Enter in either field submits', () => {
        const { container, p } = renderForm();
        const form = container.querySelector('form');
        expect(within(form).getByTestId('username')).toBeInTheDocument();
        expect(within(form).getByTestId('password')).toBeInTheDocument();
        fireEvent.submit(form);
        expect(p.handleSubmit).toHaveBeenCalled();
    });

    it('locks every method while a request is in flight', () => {
        renderForm({ isLoading: true, isGoogleConfigured: true, isMicrosoftConfigured: true });
        expect(screen.getByTestId('login-submit-button')).toBeDisabled();
        expect(screen.getByTestId('sso-google-button')).toBeDisabled();
        expect(screen.getByTestId('sso-microsoft-button')).toBeDisabled();
    });

    // wrat: the create-account button is NOT disabled while a login is in
    // flight, so it can be pressed mid-request and swaps the whole page for the
    // signup wizard. Hoort in stage L16 te veranderen.
    it('leaves the create-account button clickable during a login request', () => {
        const { p } = renderForm({ isLoading: true });
        const create = screen.getByTestId('create-account-button');
        expect(create).not.toBeDisabled();
        fireEvent.click(create);
        expect(p.setSignupMode).toHaveBeenCalledWith(true);
        expect(p.setError).toHaveBeenCalledWith('');
    });

    it('offers the email field to password managers as an email autocomplete', () => {
        renderForm();
        expect(screen.getByTestId('username')).toHaveAttribute('autocomplete', 'email');
        expect(screen.getByTestId('username')).toHaveAttribute('inputmode', 'email');
        // wrat: the field is type="text", not type="email", and the password
        // field carries no autoComplete="current-password" at all — so browser
        // and password-manager heuristics are the only thing filling this form.
        // Hoort in stage L12 te veranderen.
        expect(screen.getByTestId('username')).toHaveAttribute('type', 'text');
        expect(screen.getByTestId('password')).not.toHaveAttribute('autocomplete');
    });
});

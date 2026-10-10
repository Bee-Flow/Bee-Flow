import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of Settings → Security: MFA status, TOTP enrollment, the
 * one-time recovery sheet, disable/regenerate, and the password form.
 *
 * No i18n mock: the real hook resolves against the EN catalogue, so every
 * string asserted here is the string a user actually reads — which for a few
 * keys is NOT the inline fallback in the source.
 *
 * The vault is stubbed; it has its own file (TokenVaultSection.test.jsx).
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('./TokenVaultSection', async () => {
    const React = await import('react');
    return { default: () => React.createElement('div', { 'data-testid': 'token-vault-stub' }) };
});
// The MCP tokens panel has its own tests (components/mcpAccess).
vi.mock('../../components/mcpAccess/McpTokensPanel', async () => {
    const React = await import('react');
    return { default: () => React.createElement('div', { 'data-testid': 'mcp-tokens-stub' }) };
});
// The security-keys card has its own tests, and how this screen drives it is in
// SecuritySection.securityKeys.test.tsx.
vi.mock('../../components/mfa/SecurityKeysCard', async () => {
    const React = await import('react');
    return { default: () => React.createElement('div', { 'data-testid': 'security-keys-stub' }) };
});

import SecuritySection from './SecuritySection';
import { authFetch } from '../../utils/helpers';

const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const ENABLED = { enabled: true, recoveryCodesRemaining: 8, hasPassword: true };
const DISABLED = { enabled: false, recoveryCodesRemaining: 0, hasPassword: true };
const SETUP = { otpauthUrl: 'otpauth://totp/x', qr: 'data:image/png;base64,QQ==', secret: 'JBSWY3DPEHPK3PXP', serverTime: Date.now() };

/**
 * Route every call the screen makes. `status` may be a response object so a
 * test can pin a failing status probe; the rest default to plain successes.
 */
function serve({ status = jsonRes(DISABLED), setup, enable, disable, regenerate, changePassword, policies } = {}) {
    authFetch.mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/auth/mfa/status')) return status;
        if (u.includes('/auth/mfa/setup')) return setup || jsonRes(SETUP);
        if (u.includes('/auth/mfa/enable')) return enable || jsonRes({ recoveryCodes: ['aaaa-1111', 'bbbb-2222'] });
        if (u.includes('/auth/mfa/disable')) return disable || jsonRes({ success: true });
        if (u.includes('/auth/mfa/recovery-codes/regenerate')) return regenerate || jsonRes({ recoveryCodes: ['cccc-3333'] });
        if (u.includes('/auth/change-password')) return changePassword || jsonRes({ success: true });
        if (u.includes('/api/compliance/iso/docs')) return policies || jsonRes({ error: 'unlicensed' }, 402);
        throw new Error(`unrouted call: ${u}`);
    });
}

const posts = (fragment) => authFetch.mock.calls.filter(c => c[1]?.method === 'POST' && String(c[0]).includes(fragment));

/** Mount and wait for the status probe to settle. */
async function mount(opts) {
    serve(opts);
    const view = render(<SecuritySection />);
    await screen.findByRole('heading', { name: 'Security' });
    return view;
}

/** Enabled account → open the "regenerate" confirm panel. */
async function openRegenerate() {
    await mount({ status: jsonRes(ENABLED) });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate recovery codes' }));
    return screen.getByPlaceholderText('000000 or a1b2-c3d4');
}

const pwInputs = (container) => ({
    current: container.querySelector('input[autocomplete="current-password"]'),
    next: container.querySelectorAll('input[autocomplete="new-password"]')[0],
    confirm: container.querySelectorAll('input[autocomplete="new-password"]')[1],
});

beforeEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SecuritySection — status probe', () => {
    it('renders only a spinner until the status call resolves', async () => {
        let release;
        authFetch.mockImplementation(() => new Promise(res => { release = () => res(jsonRes(DISABLED)); }));
        const { container } = render(<SecuritySection />);

        expect(screen.queryByRole('heading', { name: 'Security' })).toBeNull();
        expect(container.querySelector('.animate-spin')).toBeTruthy();

        release();
        await screen.findByRole('heading', { name: 'Security' });
    });

    it('shows the off state with an Enable button for an account without MFA', async () => {
        await mount({ status: jsonRes(DISABLED) });
        expect(screen.getByText('Two-factor authentication is off')).toBeInTheDocument();
        expect(screen.getByText('Use an authenticator app for an extra layer of security.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    });

    it('shows the on state with the remaining recovery codes and both actions', async () => {
        await mount({ status: jsonRes(ENABLED) });
        expect(screen.getByText('Two-factor authentication is on')).toBeInTheDocument();
        expect(screen.getByText('8 recovery codes remaining')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    });

    it('SECURITY: a failing status probe renders "off" — the screen states a fact it does not know', async () => {
        // loadStatus only assigns on res.ok, so a 500 leaves the optimistic
        // initial state {enabled:false} standing. No banner, no retry: an
        // account WITH 2FA is told 2FA is off, and offered "Enable".
        await mount({ status: jsonRes({ error: 'Failed to load MFA status' }, 500) });

        expect(screen.getByText('Two-factor authentication is off')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
        expect(screen.queryByText(/Request failed/)).toBeNull();
        expect(screen.queryByText(/could not/i)).toBeNull();
    });

    it('SECURITY: a thrown status probe renders "off" as well, and hides the password form', async () => {
        authFetch.mockImplementation(async (url) => {
            if (String(url).includes('/auth/mfa/status')) throw new Error('offline');
            return jsonRes({}, 402);
        });
        render(<SecuritySection />);
        await screen.findByRole('heading', { name: 'Security' });

        expect(screen.getByText('Two-factor authentication is off')).toBeInTheDocument();
        // hasPassword is unknown, so the change-password card silently vanishes.
        expect(screen.queryByText('Change password')).toBeNull();
    });

    it('WART: MFA on with an unknown code count prints "undefined" and suppresses the low-codes warning', async () => {
        await mount({ status: jsonRes({ enabled: true, hasPassword: true }) });
        expect(screen.getByText('undefined recovery codes remaining')).toBeInTheDocument();
        expect(screen.queryByText(/running low on recovery codes/)).toBeNull();
    });

    it('warns at three remaining codes but not at four', async () => {
        await mount({ status: jsonRes({ ...ENABLED, recoveryCodesRemaining: 3 }) });
        expect(screen.getByText(/You are running low on recovery codes/)).toBeInTheDocument();

        cleanup();
        vi.clearAllMocks();
        await mount({ status: jsonRes({ ...ENABLED, recoveryCodesRemaining: 4 }) });
        expect(screen.queryByText(/You are running low on recovery codes/)).toBeNull();
    });

    it('still tells a user with zero codes left to confirm with one (wart in the copy)', async () => {
        await mount({ status: jsonRes({ ...ENABLED, recoveryCodesRemaining: 0 }) });
        expect(screen.getByText('0 recovery codes remaining')).toBeInTheDocument();
        expect(screen.getByText(/while you still have one to confirm with/)).toBeInTheDocument();
    });
});

describe('SecuritySection — enrollment', () => {
    it('posts an empty body to /auth/mfa/setup and shows the QR, the manual key and the steps', async () => {
        await mount({ status: jsonRes(DISABLED) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

        const qr = await screen.findByAltText('MFA QR code');
        expect(qr).toHaveAttribute('src', SETUP.qr);
        expect(posts('/auth/mfa/setup')[0][1].body).toBe('{}');
        // The setup key is in the DOM from the start; <details> only hides it visually.
        expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
        expect(screen.getByText(/Install an authenticator app on your phone/)).toBeInTheDocument();
        expect(screen.getByText('Enter the 6-digit code the app shows to confirm.')).toBeInTheDocument();
        // BFSF-280: enrolling on a phone needs the tap-to-add link, not only the QR.
        expect(screen.getByRole('link', { name: 'Add to the authenticator app on this device' })).toHaveAttribute('href', SETUP.otpauthUrl);
    });

    it('offers the AI help assistant inside enrollment', async () => {
        await mount({ status: jsonRes(DISABLED) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await screen.findByAltText('MFA QR code');
        expect(screen.getByRole('button', { name: 'Questions? Ask the AI assistant' })).toBeInTheDocument();
    });

    it('keeps the confirm button disabled until six digits are typed', async () => {
        await mount({ status: jsonRes(DISABLED) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await screen.findByAltText('MFA QR code');

        const confirm = screen.getByRole('button', { name: 'Enable' });
        expect(confirm.disabled).toBe(true);
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '12345' } });
        expect(screen.getByRole('button', { name: 'Enable' }).disabled).toBe(true);
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
        expect(screen.getByRole('button', { name: 'Enable' }).disabled).toBe(false);
    });

    it('warns about a device clock more than 30s off the server', async () => {
        await mount({ status: jsonRes(DISABLED), setup: jsonRes({ ...SETUP, serverTime: Date.now() - 120_000 }) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        expect(await screen.findByText(/differs from the server by about 1[12][0-9] seconds/)).toBeInTheDocument();
    });

    it('stays quiet at a 20s drift, and also when the server sends no serverTime at all (wart)', async () => {
        await mount({ status: jsonRes(DISABLED), setup: jsonRes({ ...SETUP, serverTime: Date.now() - 20_000 }) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await screen.findByAltText('MFA QR code');
        expect(screen.queryByText(/differs from the server/)).toBeNull();

        cleanup();
        vi.clearAllMocks();
        // An older server omitting serverTime is read as "no drift", not "unknown".
        await mount({ status: jsonRes(DISABLED), setup: jsonRes({ otpauthUrl: 'x', qr: 'data:,', secret: 'S' }) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await screen.findByAltText('MFA QR code');
        expect(screen.queryByText(/differs from the server/)).toBeNull();
    });

    it('cancelling enrollment drops the QR and returns to the off card', async () => {
        await mount({ status: jsonRes(DISABLED) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await screen.findByAltText('MFA QR code');

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByAltText('MFA QR code')).toBeNull();
        expect(screen.getByText('Two-factor authentication is off')).toBeInTheDocument();
    });

    it('confirms with a trimmed code, shows the one-time sheet and re-reads the status', async () => {
        await mount({ status: jsonRes(DISABLED) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await screen.findByAltText('MFA QR code');

        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: ' 123456 ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

        expect(await screen.findByText(/Save these one-time recovery codes somewhere safe/)).toBeInTheDocument();
        expect(JSON.parse(posts('/auth/mfa/enable')[0][1].body)).toEqual({ code: '123456' });
        expect(screen.getByText('aaaa-1111')).toBeInTheDocument();
        expect(screen.getByText('bbbb-2222')).toBeInTheDocument();
        await waitFor(() => expect(authFetch.mock.calls.filter(c => String(c[0]).includes('/auth/mfa/status'))).toHaveLength(2));
    });

    it('WART: a server that returns no codes still renders the "save these codes" sheet — empty', async () => {
        await mount({ status: jsonRes(DISABLED), enable: jsonRes({ success: true }) });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
        await screen.findByAltText('MFA QR code');
        fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

        expect(await screen.findByText(/Save these one-time recovery codes somewhere safe/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'I’ve saved them' })).toBeInTheDocument();
        expect(screen.queryByText(/^[a-z0-9]{4}-[a-z0-9]{4}$/)).toBeNull();
    });

    it('G6 BASELINE: the sheet is shown once — dismissing it leaves no way back to the codes', async () => {
        // Today the ONLY route to a recovery sheet is minting a new one, which
        // itself needs a working second factor. Nothing on this screen offers
        // "show them again", and this test is what a G6 change has to move.
        await mount({ status: jsonRes(ENABLED) });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate recovery codes' }));
        fireEvent.change(screen.getByPlaceholderText('000000 or a1b2-c3d4'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        expect(await screen.findByText('cccc-3333')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'I’ve saved them' }));

        expect(screen.queryByText('cccc-3333')).toBeNull();
        expect(screen.queryByText(/Save these one-time recovery codes somewhere safe/)).toBeNull();
        expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
        expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeInTheDocument();
    });
});

describe('SecuritySection — disable and regenerate', () => {
    it('asks for a code or recovery code before regenerating, and cancels cleanly', async () => {
        const input = await openRegenerate();
        expect(screen.getByText('Enter a 6-digit code or a recovery code to confirm')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Regenerate' }).disabled).toBe(true);

        fireEvent.change(input, { target: { value: 'a1b2-c3d4' } });
        expect(screen.getByRole('button', { name: 'Regenerate' }).disabled).toBe(false);

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByPlaceholderText('000000 or a1b2-c3d4')).toBeNull();
        expect(screen.getByRole('button', { name: 'Regenerate recovery codes' })).toBeInTheDocument();
    });

    it('sends the trimmed confirmation code to the regenerate endpoint', async () => {
        const input = await openRegenerate();
        fireEvent.change(input, { target: { value: '  a1b2-c3d4  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        await waitFor(() => expect(posts('/auth/mfa/recovery-codes/regenerate')).toHaveLength(1));
        expect(JSON.parse(posts('/auth/mfa/recovery-codes/regenerate')[0][1].body)).toEqual({ code: 'a1b2-c3d4' });
    });

    it('disabling posts the code and flips the card to off', async () => {
        let statusRes = jsonRes(ENABLED);
        serve({ status: jsonRes(ENABLED) });
        authFetch.mockImplementation(async (url, opts = {}) => {
            const u = String(url);
            if (u.includes('/auth/mfa/status')) return statusRes;
            if (u.includes('/auth/mfa/disable')) { statusRes = jsonRes(DISABLED); return jsonRes({ success: true }); }
            if (u.includes('/api/compliance/iso/docs')) return jsonRes({}, 402);
            throw new Error(`unrouted: ${u} ${opts.method}`);
        });
        render(<SecuritySection />);
        await screen.findByText('Two-factor authentication is on');

        fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
        fireEvent.change(screen.getByPlaceholderText('000000 or a1b2-c3d4'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

        expect(await screen.findByText('Two-factor authentication is off')).toBeInTheDocument();
        expect(JSON.parse(posts('/auth/mfa/disable')[0][1].body)).toEqual({ code: '123456' });
    });
});

describe('SecuritySection — how server errors reach the user', () => {
    it('translates invalid_code to the CATALOGUE wording, not the fallback in the source', async () => {
        // Source fallback: "Invalid code. Check your authenticator app and try
        // again." — the EN catalogue overrides it, so the extra guidance the
        // fallback promises is never shown.
        const input = await openRegenerate();
        serve({ status: jsonRes(ENABLED), regenerate: jsonRes({ error: 'Invalid code.', code: 'invalid_code' }, 400) });
        fireEvent.change(input, { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        expect(await screen.findByText('Invalid code. Please try again.')).toBeInTheDocument();
        expect(screen.queryByText(/Check your authenticator app/)).toBeNull();
    });

    it('a 429 outranks whatever code the body carries', async () => {
        const input = await openRegenerate();
        serve({ status: jsonRes(ENABLED), regenerate: jsonRes({ error: 'slow down', code: 'invalid_code' }, 429) });
        fireEvent.change(input, { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        expect(await screen.findByText('Too many attempts — wait a few minutes and try again.')).toBeInTheDocument();
    });

    it('mfa_secret_unreadable points at a recovery code or an administrator', async () => {
        const input = await openRegenerate();
        serve({ status: jsonRes(ENABLED), regenerate: jsonRes({ code: 'mfa_secret_unreadable' }, 400) });
        fireEvent.change(input, { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        expect(await screen.findByText(/Use a recovery code, or ask your administrator to reset two-factor authentication/)).toBeInTheDocument();
    });

    it('WART: an unmapped code echoes the raw English server message the comment says it avoids', async () => {
        const input = await openRegenerate();
        serve({ status: jsonRes(ENABLED), regenerate: jsonRes({ error: 'Start MFA setup first', code: 'setup_required' }, 400) });
        fireEvent.change(input, { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        expect(await screen.findByText('Start MFA setup first')).toBeInTheDocument();
    });

    it('WART: a bodyless failure shows the literal "Request failed" — mfa.request_failed is unreachable', async () => {
        // post() always builds an Error with the message 'Request failed', so
        // msgFor's default branch returns e.message and never reaches its own
        // localized string ("Request failed. Please try again.").
        const input = await openRegenerate();
        serve({ status: jsonRes(ENABLED), regenerate: jsonRes({}, 500) });
        fireEvent.change(input, { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        expect(await screen.findByText('Request failed')).toBeInTheDocument();
        expect(screen.queryByText('Request failed. Please try again.')).toBeNull();
    });

    it('WART: a transport exception is printed verbatim on the page', async () => {
        const input = await openRegenerate();
        authFetch.mockImplementation(async (url) => {
            const u = String(url);
            if (u.includes('/auth/mfa/status')) return jsonRes(ENABLED);
            if (u.includes('/api/compliance/iso/docs')) return jsonRes({}, 402);
            throw new Error('NetworkError when attempting to fetch resource.');
        });
        fireEvent.change(input, { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

        expect(await screen.findByText('NetworkError when attempting to fetch resource.')).toBeInTheDocument();
    });

    it('clears a standing error when the user cancels out of the confirm panel', async () => {
        const input = await openRegenerate();
        serve({ status: jsonRes(ENABLED), regenerate: jsonRes({ code: 'invalid_code' }, 400) });
        fireEvent.change(input, { target: { value: '000000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
        await screen.findByText('Invalid code. Please try again.');

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByText('Invalid code. Please try again.')).toBeNull();
    });
});

describe('SecuritySection — change password', () => {
    it('appears only for accounts the server says have a password', async () => {
        await mount({ status: jsonRes({ ...ENABLED, hasPassword: false }) });
        expect(screen.queryByText('Change password')).toBeNull();

        cleanup();
        vi.clearAllMocks();
        await mount({ status: jsonRes(ENABLED) });
        expect(screen.getByText('Change password')).toBeInTheDocument();
    });

    it('WART: the three password fields have labels that are not tied to any input', async () => {
        const { container } = await mount({ status: jsonRes(ENABLED) });
        // All three labels: visible text, but no htmlFor / id / aria-label, so
        // none of them resolves as an accessible name.
        for (const text of ['Current password', 'New password', 'Confirm new password']) {
            expect(screen.getByText(text)).toBeInTheDocument();
            expect(() => screen.getByLabelText(text)).toThrow();
        }
        const f = pwInputs(container);
        expect(f.current).toBeTruthy();
        expect(f.next).toBeTruthy();
        expect(f.confirm).toBeTruthy();
    });

    it('rejects a short password in the browser without contacting the server', async () => {
        const { container } = await mount({ status: jsonRes(ENABLED) });
        const f = pwInputs(container);
        fireEvent.change(f.current, { target: { value: 'oldpassword' } });
        fireEvent.change(f.next, { target: { value: 'short' } });
        fireEvent.change(f.confirm, { target: { value: 'short' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

        expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();
        expect(posts('/auth/change-password')).toHaveLength(0);
    });

    it('rejects a mismatched confirmation without contacting the server', async () => {
        const { container } = await mount({ status: jsonRes(ENABLED) });
        const f = pwInputs(container);
        fireEvent.change(f.current, { target: { value: 'oldpassword' } });
        fireEvent.change(f.next, { target: { value: 'longenough1' } });
        fireEvent.change(f.confirm, { target: { value: 'longenough2' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

        expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
        expect(posts('/auth/change-password')).toHaveLength(0);
    });

    it('posts both passwords in the clear body and empties the form on success', async () => {
        const { container } = await mount({ status: jsonRes(ENABLED) });
        const f = pwInputs(container);
        fireEvent.change(f.current, { target: { value: 'oldpassword' } });
        fireEvent.change(f.next, { target: { value: 'longenough1' } });
        fireEvent.change(f.confirm, { target: { value: 'longenough1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

        expect(await screen.findByText('Password changed successfully.')).toBeInTheDocument();
        expect(JSON.parse(posts('/auth/change-password')[0][1].body))
            .toEqual({ oldPassword: 'oldpassword', newPassword: 'longenough1' });
        const after = pwInputs(container);
        expect(after.current.value).toBe('');
        expect(after.next.value).toBe('');
    });

    it('WART: a 200 without success:true is a failure, and the raw server error is echoed', async () => {
        const { container } = await mount({
            status: jsonRes(ENABLED),
            changePassword: jsonRes({ error: 'Current password is incorrect' }),
        });
        const f = pwInputs(container);
        fireEvent.change(f.current, { target: { value: 'oldpassword' } });
        fireEvent.change(f.next, { target: { value: 'longenough1' } });
        fireEvent.change(f.confirm, { target: { value: 'longenough1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

        expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
        expect(screen.queryByText('Password changed successfully.')).toBeNull();
    });
});

describe('SecuritySection — what else lives on this screen', () => {
    it('always mounts the personal token vault', async () => {
        await mount({ status: jsonRes(DISABLED) });
        expect(screen.getByTestId('token-vault-stub')).toBeInTheDocument();
    });

    it('keeps the ISMS policy card invisible when the compliance call is refused', async () => {
        await mount({ status: jsonRes(DISABLED), policies: jsonRes({ error: 'unlicensed' }, 402) });
        await waitFor(() => expect(authFetch.mock.calls.some(c => String(c[0]).includes('/api/compliance/iso/docs'))).toBe(true));
        // Assert the RENDERED heading, not the key: t() resolves
        // settings.policy_ack_title against the EN catalogue, so a query for
        // the bare key is null whether the card is on screen or not.
        expect(screen.queryByText('Organisation policies')).toBeNull();
        expect(screen.queryByText('Policies your organisation asks you to read and confirm.')).toBeNull();
    });

    it('shows the section heading and its one-line explanation', async () => {
        await mount({ status: jsonRes(DISABLED) });
        expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
        expect(screen.getByText('Add a second factor to protect your account at sign-in.')).toBeInTheDocument();
    });
});

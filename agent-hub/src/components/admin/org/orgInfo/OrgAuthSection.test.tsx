// The preferred sign-in method offers only what this server has set up (the
// same /auth/setup-status the login page reads), and is never locked: nothing
// reads it when someone signs in.

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContextType } from 'react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import OrgAuthSection from './OrgAuthSection';
import { unavailableSignInMethods } from './signInAvailability';
import type { OrgFormData } from './orgInfoFormRows';
import LicenseContext from '@/components/licensing/LicenseContext';
import { useTranslation } from '@/hooks/useTranslation';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';

type License = ContextType<typeof LicenseContext>;

const ORG = { id: 'org1', name: 'Acme', authMethod: 'password', allowedDomains: [], autoApproveSSO: false, nc: null } as unknown as OrgFormData;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let puts: Array<{ url: string; body: unknown }>;
let refusePut = false;

function serveSetupStatus(status: Record<string, unknown> | null) {
    puts = [];
    refusePut = false;
    setDemoTransport(async (url: unknown, init: RequestInit = {}) => {
        if ((init.method || 'GET') === 'PUT') {
            puts.push({ url: String(url), body: JSON.parse(String(init.body)) });
            return refusePut ? json({ error: 'nope' }, 500) : json({ success: true });
        }
        return String(url).endsWith('/auth/setup-status') && status ? json(status) : json({}, 404);
    });
}
afterEach(() => { setDemoTransport(null); });

function Section({ isSelfHosted }: { isSelfHosted: boolean }) {
    const { t } = useTranslation();
    const [orgData, setOrgData] = useState<OrgFormData | null>(ORG);
    return orgData ? <OrgAuthSection t={t} orgData={orgData} setOrgData={setOrgData} isSelfHosted={isSelfHosted} /> : null;
}

function renderSection({ isSelfHosted = false, features = [] as string[] } = {}) {
    const license = { hasFeature: (name: string) => features.includes(name), deploymentMode: isSelfHosted ? 'self-hosted' : 'cloud' } as Partial<License> as License;
    return renderWithClient(
        <LicenseContext.Provider value={license}>
            <Section isSelfHosted={isSelfHosted} />
        </LicenseContext.Provider>,
    );
}

const radio = (name: RegExp) => within(screen.getByRole('radiogroup', { name: 'Preferred sign-in method' })).getByRole('radio', { name });

describe('OrgAuthSection', () => {
    it('offers only the methods this server has set up, and says why the others are not', async () => {
        serveSetupStatus({ isGoogleConfigured: false, isMicrosoftConfigured: true, microsoftLogins: [{ id: 'default' }], allowPasswordLogin: true });
        renderSection();
        expect(await screen.findByText(/Not set up on this server yet/)).toBeInTheDocument();
        expect(radio(/Sign in with Google/)).toBeDisabled();
        expect(radio(/Sign in with Microsoft/)).toBeEnabled();
        expect(radio(/Username & Password/)).toBeEnabled();
    });

    it('with password sign-in turned off, the password card says so', async () => {
        serveSetupStatus({ isGoogleConfigured: true, isMicrosoftConfigured: true, allowPasswordLogin: false });
        renderSection();
        expect(await screen.findByText('Password sign-in is turned off on this server.')).toBeInTheDocument();
        expect(radio(/Username & Password/)).toBeDisabled();
    });

    it('on a self-hosted server, Google and Microsoft also need the SSO licence', async () => {
        serveSetupStatus({ isGoogleConfigured: true, isMicrosoftConfigured: true, allowPasswordLogin: true });
        renderSection({ isSelfHosted: true });
        expect(await screen.findAllByText("Not included in this server's licence.")).toHaveLength(2);
        expect(radio(/Sign in with Google/)).toBeDisabled();
    });

    it('is never locked: a stored method can be changed, without any lock copy', async () => {
        serveSetupStatus({ isGoogleConfigured: true, isMicrosoftConfigured: true, allowPasswordLogin: true });
        const user = userEvent.setup();
        renderSection({ isSelfHosted: true, features: ['sso_saml'] });
        await screen.findByRole('radiogroup', { name: 'Preferred sign-in method' });
        expect(radio(/Username & Password/)).toHaveAttribute('aria-checked', 'true');
        await user.click(radio(/Sign in with Google/));
        expect(await screen.findByRole('radio', { name: /Sign in with Google/, checked: true })).toBeInTheDocument();
        expect(screen.queryByText(/locked|cannot be changed|Choose carefully/i)).toBeNull();
    });
});

describe('OrgAuthSection: the page frame names it', () => {
    it('draws no page title of its own (the dashboard frame does)', async () => {
        serveSetupStatus({ isGoogleConfigured: true, isMicrosoftConfigured: true, allowPasswordLogin: true });
        renderSection();
        await screen.findByRole('radiogroup', { name: 'Preferred sign-in method' });
        expect(screen.queryByRole('heading', { name: 'Preferred sign-in method' })).toBeNull();
    });
});

// Auto-approve has one home: this row. It stores itself when it moves, alone.
describe('OrgAuthSection: auto-approve', () => {
    const SWITCH = /Let people from your domains in straight away/;

    it('stores the switch the moment it moves, and only that field', async () => {
        serveSetupStatus({ isGoogleConfigured: true, isMicrosoftConfigured: true, allowPasswordLogin: true });
        const user = userEvent.setup();
        renderSection();
        const toggle = await screen.findByRole('switch', { name: SWITCH });
        expect(toggle).not.toBeChecked();
        await user.click(toggle);
        await waitFor(() => expect(puts).toEqual([{ url: expect.stringMatching(/\/auth\/organizations\/org1$/), body: { autoApproveSSO: true } }]));
        expect(screen.getByRole('switch', { name: SWITCH })).toBeChecked();
    });

    it('puts the switch back and says so when the save is refused', async () => {
        serveSetupStatus({ isGoogleConfigured: true, isMicrosoftConfigured: true, allowPasswordLogin: true });
        refusePut = true;
        const user = userEvent.setup();
        renderSection();
        await user.click(await screen.findByRole('switch', { name: SWITCH }));
        expect(await screen.findByText('The setting could not be saved. Try again.')).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: SWITCH })).not.toBeChecked();
    });

    it('is offered on cloud and self-hosted alike', async () => {
        serveSetupStatus({ isGoogleConfigured: true, isMicrosoftConfigured: true, allowPasswordLogin: true });
        renderSection({ isSelfHosted: true, features: ['sso_saml'] });
        expect(await screen.findByRole('switch', { name: SWITCH })).toBeInTheDocument();
    });
});

describe('unavailableSignInMethods', () => {
    it('restricts nothing before the server answered', () => {
        expect(unavailableSignInMethods(null, { ssoLicensed: false, licenceApplies: true })).toEqual({});
    });

    it('reads Microsoft from its list of connections when the server sends one', () => {
        const opts = { ssoLicensed: true, licenceApplies: true };
        expect(unavailableSignInMethods({ isGoogleConfigured: true, isMicrosoftConfigured: true, microsoftLogins: [] }, opts)).toEqual({ microsoft: 'not_set_up' });
        expect(unavailableSignInMethods({ isGoogleConfigured: true, isMicrosoftConfigured: true }, opts)).toEqual({});
    });
});

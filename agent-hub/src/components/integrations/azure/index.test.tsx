/**
 * Organisation > Azure for the platform admin (OrgAzureConfigPanel): Microsoft
 * SSO is Enterprise (`sso_saml`), as on Security > SSO. Without the licence
 * feature the panel does not offer the SSO section (the server refuses its save
 * too); with it, the section is there.
 */
import { useContext, type ComponentProps } from 'react';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import LicenseContext from '@/components/licensing/LicenseContext';
import OrgAzureConfigPanel from './index';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ azureEndpoint: '', chatModelTiers: null, autoApproveSSO: false }));
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

type LicenseValue = ComponentProps<typeof LicenseContext.Provider>['value'];

/** The default licence context with `features` as the effective set. */
function mount(features: string[]) {
    const Probe = () => {
        const base = useContext(LicenseContext);
        const value: LicenseValue = { ...base, loading: false, features, hasFeature: (name: string) => features.includes(name) };
        return (
            <LicenseContext.Provider value={value}>
                <OrgAzureConfigPanel user={{ organizationId: 'org1' }} />
            </LicenseContext.Provider>
        );
    };
    return renderWithClient(<Probe />);
}

describe('OrgAzureConfigPanel and the sso_saml licence feature', () => {
    it('does not offer Microsoft SSO without sso_saml', async () => {
        mount([]);
        expect(await screen.findByText('Azure OpenAI')).toBeInTheDocument();
        expect(screen.queryByText('Microsoft SSO')).toBeNull();
    });

    it('offers Microsoft SSO with sso_saml', async () => {
        mount(['sso_saml']);
        expect(await screen.findByText('Azure OpenAI')).toBeInTheDocument();
        expect(screen.getByText('Microsoft SSO')).toBeInTheDocument();
    });
});

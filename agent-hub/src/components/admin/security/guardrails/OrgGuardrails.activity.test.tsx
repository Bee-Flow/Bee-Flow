// The organisation shield in the admin dashboard offers the "What happened"
// tab, and that tab reads the organisation the shield is about.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OrgGuardrails from './OrgGuardrails';
import LicenseContext from '@/components/licensing/LicenseContext';
import { renderWithClient } from '@/test/render';

type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];

const SHIELD = {
    enabled: true,
    collectionIds: [],
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    customSensitiveTerms: [],
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
};

let requested: string[];

beforeEach(() => {
    requested = [];
    window.history.replaceState({}, '', '/app/admin/security/guardrails');
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        requested.push(String(url));
        const path = String(url);
        let body: unknown = {};
        if (path.includes('/api/org-privacy-shield/')) body = SHIELD;
        else if (path.includes('/auth/organizations')) body = [{ id: 'org-9', name: 'Nine' }, { id: 'org-1', name: 'One' }];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

function renderShield(props: React.ComponentProps<typeof OrgGuardrails>) {
    const license = { tier: 'enterprise', hasFeature: () => true, hasTier: () => true } as unknown as LicenseValue;
    return renderWithClient(<LicenseContext.Provider value={license}><OrgGuardrails {...props} /></LicenseContext.Provider>);
}

const usageCalls = () => requested.filter(u => u.includes('/api/usage/guardrails/overview'));
const activityTab = () => screen.findByRole('tab', { name: /What happened/ });

describe('OrgGuardrails activity tab', () => {
    it('gives an organisation admin the tab, reading their own organisation without naming one', async () => {
        const user = userEvent.setup();
        renderShield({ orgId: 'org-1' });
        await user.click(await activityTab());
        await waitFor(() => expect(usageCalls().length).toBeGreaterThan(0));
        expect(usageCalls().every(u => !u.includes('orgId='))).toBe(true);
    });

    it('gives a platform admin the tab for the chosen organisation, and reads that organisation', async () => {
        const user = userEvent.setup();
        renderShield({ orgId: 'org-9', activityOrgId: 'org-9', allowOrgPicker: true });
        await user.click(await activityTab());
        await waitFor(() => expect(usageCalls().length).toBeGreaterThan(0));
        expect(usageCalls().every(u => u.includes('orgId=org-9'))).toBe(true);
        expect(requested.some(u => u.includes('/api/org-privacy-shield/org-9'))).toBe(true);
    });

    it('offers no tab while the platform admin still has to pick an organisation', async () => {
        renderShield({ orgId: null, allowOrgPicker: true });
        await waitFor(() => expect(requested.some(u => u.includes('/auth/organizations'))).toBe(true));
        expect(screen.queryByRole('tab', { name: /What happened/ })).not.toBeInTheDocument();
    });
});

// The subscription gate: where an organisation without a plan is sent, and the
// licence pages it lets render so the admin can subscribe.
import { render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LicenseContext from '@/components/licensing/LicenseContext';
import { SubscriptionProvider } from '@/components/licensing/SubscriptionContext';
import { SubscriptionGate } from './guards';

type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];

const member = { id: 'u2', organizationId: 'org-a' };

beforeEach(() => {
    // No subscription for the organisation.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.restoreAllMocks(); });

/** A phone answers the viewport's mobile query; a desktop answers none. */
function setPhone(phone: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        matches: phone && query === '(max-width: 767px)', media: query, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }) as MediaQueryList);
}

async function gate(path: string, { phone = false } = {}) {
    setPhone(phone);
    window.history.replaceState(null, '', path);
    const navigateToPage = vi.fn();
    const license = { loading: false, serverOverride: false } as LicenseValue;
    render(
        <LicenseContext.Provider value={license}>
            <SubscriptionProvider user={member}>
                <SubscriptionGate user={member} currentPage="agents" deploymentMode="cloud" navigateToPage={navigateToPage} />
            </SubscriptionProvider>
        </LicenseContext.Provider>,
    );
    // Let the subscription read settle.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    return navigateToPage;
}

describe('SubscriptionGate without an active plan', () => {
    it('sends a desktop to the dashboard\'s licence page', async () => {
        const nav = await gate('/app/agents');
        await vi.waitFor(() => expect(nav).toHaveBeenCalledWith('admin/organisation/license'));
    });

    it('lets the dashboard\'s licence page render, so a no-plan organisation admin is not bounced from it', async () => {
        const nav = await gate('/app/admin/organisation/license');
        expect(nav).not.toHaveBeenCalled();
    });

    it('lets the Settings licence page (the Stripe return address) render too, with its query', async () => {
        const nav = await gate('/app/settings/organisation/license?checkout=success');
        expect(nav).not.toHaveBeenCalled();
    });

    it('sends a phone to the Settings licence page, as before', async () => {
        const nav = await gate('/app/agents', { phone: true });
        await vi.waitFor(() => expect(nav).toHaveBeenCalledWith('settings/organisation/license'));
    });
});

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TranslationProvider } from '../../hooks/useTranslation';
import NcOnboardingWizard from './index';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TranslationProvider>
                <NcOnboardingWizard user={{ organizationId: 'org-1', email: 'admin@example.org' }} orgName="Acme" deploymentMode="self-hosted" />
            </TranslationProvider>
        </QueryClientProvider>,
    );
}

const next = () => screen.getByRole('button', { name: 'Next' });

describe('NcOnboardingWizard', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/nc-sync/groups')) return json({ groups: ['admin', 'staff'] });
            if (url.includes('/auth/organizations/')) return json({ name: 'Acme', email: 'admin@example.org' });
            return json({});
        }));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('names the step it is on and how far along it is', async () => {
        const user = userEvent.setup();
        mount();
        expect(screen.getByRole('heading', { level: 1, name: 'Welcome to Bee Flow for Acme' })).toBeInTheDocument();
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
        expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

        await user.click(next());
        expect(screen.getByRole('heading', { level: 1, name: 'Organisation details' })).toBeInTheDocument();
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    });

    it('labels every organisation field and does not go on without a name', async () => {
        const user = userEvent.setup();
        mount();
        await user.click(next());
        const name = await screen.findByLabelText('Organisation name *');
        await vi.waitFor(() => expect(name).toHaveValue('Acme'));
        for (const label of ['Billing email', 'Tagline', 'Phone', 'Website', 'Address', 'Chamber of Commerce (KVK)', 'VAT']) {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        }
        await user.clear(name);
        expect(next()).toBeDisabled();
        await user.type(name, 'Acme BV');
        expect(next()).toBeEnabled();
    });

    it('offers the sync choices as radio groups and the groups Nextcloud has', async () => {
        const user = userEvent.setup();
        mount();
        await user.click(next());
        await vi.waitFor(() => expect(screen.getByLabelText('Organisation name *')).toHaveValue('Acme'));
        await user.click(next());

        const who = screen.getByRole('radiogroup', { name: 'Who gets a Bee Flow account?' });
        expect(who).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: /Everyone in Nextcloud/ })).toBeChecked();
        expect(await screen.findByRole('checkbox', { name: 'admin' })).toBeChecked();

        // Only specific groups: a group has to be picked before going on.
        await user.click(screen.getByRole('radio', { name: /Only specific groups/ }));
        expect(next()).toBeDisabled();
        await user.click(screen.getAllByRole('checkbox', { name: 'staff' })[0]);
        expect(next()).toBeEnabled();
    });

    it('lists the privacy categories with their names, and needs one when the shield is on', async () => {
        const user = userEvent.setup();
        mount();
        await user.click(next());
        await vi.waitFor(() => expect(screen.getByLabelText('Organisation name *')).toHaveValue('Acme'));
        await user.click(next());
        await user.click(next());

        expect(screen.getByRole('heading', { level: 1, name: 'Privacy Shield' })).toBeInTheDocument();
        const categories = screen.getAllByRole('checkbox').filter(box => box.getAttribute('aria-label') !== 'Enable Privacy Shield');
        expect(categories).toHaveLength(8);
        for (const box of categories.filter(b => (b as HTMLInputElement).checked)) await user.click(box);
        expect(next()).toBeDisabled();
        await user.click(categories[0]);
        expect(next()).toBeEnabled();
    });
});

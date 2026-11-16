// The organisation modal no longer edits the older per-organisation
// integrations list: Access > Ceiling chooses an organisation's integrations.
// The list is still enforced on the server, so a limited organisation shows
// the limit read-only and can be handed back to Access by dropping the list.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Dispatch, SetStateAction } from 'react';
import OrganizationModal from './OrganizationModal';
import type { OrgFormData } from './types';

const t = (_key: string | undefined, fallback?: unknown, params?: unknown) => {
    let text = typeof fallback === 'string' ? fallback : String(_key);
    const values = (typeof fallback === 'object' && fallback ? fallback : params) as Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(values ?? {})) text = text.replace(`{${k}}`, String(v));
    return text;
};

const ORG: OrgFormData = {
    id: 'org-b', name: 'Org B', description: '', tagline: '', address: '', email: '', phone: '', website: '',
    kvk: '', vat: '', logo: '', footerText: '', defaultGroups: [], allowSignup: false, enabledIntegrations: ['gmail', 'maps'],
};

function renderModal(orgData: OrgFormData, setOrgData: Dispatch<SetStateAction<OrgFormData>>) {
    return render(
        <OrganizationModal
            open
            onClose={vi.fn()}
            showEditOrg
            orgData={orgData}
            setOrgData={setOrgData}
            groups={[]}
            isFullAdmin
            onSubmitAdd={vi.fn()}
            onSubmitUpdate={vi.fn()}
            onUploadLogo={vi.fn()}
            onRemoveLogo={vi.fn()}
            t={t}
        />,
    );
}

describe('OrganizationModal integrations', () => {
    it('shows a limiting list read-only, by name, with no checkboxes to edit it', () => {
        renderModal(ORG, vi.fn());
        const block = screen.getByTestId('org-modal-integrations');
        expect(block).toHaveTextContent('Limited by the older list to 2 integrations:');
        expect(block).toHaveTextContent('Gmail');
        expect(block).toHaveTextContent('Google Maps');
        expect(block.querySelector('input[type="checkbox"]')).toBeNull();
    });

    it('"Drop the older list" clears the list in the form, saved with the form', async () => {
        const user = userEvent.setup();
        const setOrgData = vi.fn<Dispatch<SetStateAction<OrgFormData>>>();
        renderModal(ORG, setOrgData);
        await user.click(screen.getByTestId('org-modal-integrations-reset'));
        const update = setOrgData.mock.calls[0][0] as (prev: OrgFormData) => OrgFormData;
        expect(update(ORG).enabledIntegrations).toBeNull();
    });

    it('without a list there is nothing to reset', () => {
        renderModal({ ...ORG, enabledIntegrations: null }, vi.fn());
        // Without a list the server reads the Defaults for new organisations (resolveOrgAllowList), so the text says so, not "every integration".
        expect(screen.getByTestId('org-modal-integrations')).toHaveTextContent("No older list: the organisation follows this server's Defaults for new organisations");
        expect(screen.queryByTestId('org-modal-integrations-reset')).toBeNull();
    });

    it('says one integration in the singular', () => {
        renderModal({ ...ORG, enabledIntegrations: ['gmail'] }, vi.fn());
        expect(screen.getByTestId('org-modal-integrations')).toHaveTextContent('Limited by the older list to 1 integration:');
    });

    it('uses neutral placeholders, not a real company', () => {
        renderModal(ORG, vi.fn());
        expect(screen.getByPlaceholderText('Company name')).toBeInTheDocument();
        expect(screen.queryByPlaceholderText(/Bee Flow/)).toBeNull();
        expect(screen.queryByPlaceholderText(/beeflow/)).toBeNull();
    });
});

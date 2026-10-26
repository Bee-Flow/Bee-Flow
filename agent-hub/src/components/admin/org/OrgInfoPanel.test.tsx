// The org form's Save button lives in OrganisationSection's save bar, but the
// save itself is OrgInfoPanel's handleSave, handed up through onStateChange.
// That hand-over only re-ran when hasChanges/saving/message changed, so the
// bar kept the handleSave of the first edit: it saved the form as it stood
// after the first keystroke and still said "Changes saved". These tests mount
// the real pair and read the PUT body.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllowedDomainsEditor } from './orgInfo/orgInfoShared';
import { useTranslation } from '@/hooks/useTranslation';
import OrganisationSection from '@/pages/settings/OrganisationSection';
import { withQueryClient } from '@/test/render';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const respond = (status: number, body: unknown) => ({
    ok: status < 400, status, json: async () => body,
});

const ORG = { id: 'org1', name: 'Old BV', tagline: '', allowedDomains: [] };
const USER = { id: 'u1', organizationId: 'org1', permissions: ['org_admin'], featureFlags: { deploymentMode: 'self-hosted' } };

type Put = { url: string; body: Record<string, unknown> };
let puts: Put[];

beforeEach(() => {
    puts = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if ((init.method || 'GET') === 'PUT') {
            puts.push({ url: String(url), body: JSON.parse(String(init.body)) });
            return respond(200, { success: true });
        }
        if (url === '/auth/organizations') return respond(200, [ORG]);
        if (url === '/auth/groups') return respond(200, []);
        return respond(404, {});
    });
});

it('saves what the form shows now, not the state after the first keystroke', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<OrganisationSection user={USER} activeSection="info" />));
    const name = await screen.findByDisplayValue('Old BV');

    await user.clear(name);
    await user.type(name, 'Acme BV');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toBe('/auth/organizations/org1');
    expect(puts[0].body.name).toBe('Acme BV');
    expect(puts[0].body).not.toHaveProperty('id');
});

it('after a save, a further edit is saved too and the bar knows it is dirty again', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<OrganisationSection user={USER} activeSection="info" />));
    const name = await screen.findByDisplayValue('Old BV');

    await user.type(name, ' one');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body.name).toBe('Old BV one');

    await user.type(name, ' two');
    const save = screen.getByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].body.name).toBe('Old BV one two');
});

it('an edit typed while the save is in flight keeps the bar dirty', async () => {
    let release: () => void = () => {};
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if ((init.method || 'GET') === 'PUT') {
            puts.push({ url: String(url), body: JSON.parse(String(init.body)) });
            await new Promise<void>(r => { release = r; });
            return respond(200, { success: true });
        }
        return base(url, init);
    });
    const user = userEvent.setup();
    render(withQueryClient(<OrganisationSection user={USER} activeSection="info" />));
    const name = await screen.findByDisplayValue('Old BV');

    await user.type(name, ' one');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    await user.type(name, ' two');
    release();

    // Once the PUT returns the button reads "Save changes" again, and it must
    // stay enabled: " two" never reached the server.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
});

// ── Organisation Info: the page names itself, and every label names its field.
describe('Organisation Info page', () => {
    it('has a page title and labels tied to their fields', async () => {
        render(withQueryClient(<OrganisationSection user={USER} activeSection="info" />));
        expect(await screen.findByRole('heading', { level: 2, name: 'Organisation Info' })).toBeInTheDocument();
        expect(screen.getByLabelText('Company Name')).toHaveValue('Old BV');
        expect(screen.getByLabelText('Country').tagName).toBe('SELECT');
    });
});

// ── Logo: the upload and remove endpoints store the change themselves, so
// their result is the truth the screen has to show.
describe('logo', () => {
    const serveLogo = (logo: string, answer: (method: string) => ReturnType<typeof respond> | null) => {
        fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
            const method = init.method || 'GET';
            if (method !== 'GET') return answer(method) ?? respond(200, {});
            if (url === '/auth/organizations') return respond(200, [{ ...ORG, logo }]);
            if (url === '/auth/groups') return respond(200, []);
            return respond(404, {});
        });
    };
    const png = () => new File(['png'], 'logo.png', { type: 'image/png' });

    it('a refused removal says so and keeps the logo', async () => {
        serveLogo('/uploads/old.png', (m) => (m === 'DELETE' ? respond(500, {}) : null));
        const user = userEvent.setup();
        render(withQueryClient(<OrganisationSection user={USER} activeSection="info" />));

        await user.click(await screen.findByRole('button', { name: 'Remove logo' }));

        expect(await screen.findByText(/Failed to remove logo/)).toBeInTheDocument();
        expect(screen.queryByText(/Logo removed/)).toBeNull();
        expect(screen.getByRole('img', { name: 'Logo' })).toBeInTheDocument();
    });

    it('a refused upload says so instead of saying nothing', async () => {
        serveLogo('', (m) => (m === 'POST' ? respond(400, { error: 'No file uploaded' }) : null));
        const user = userEvent.setup();
        render(withQueryClient(<OrganisationSection user={USER} activeSection="info" />));

        await user.upload(await screen.findByLabelText('Upload Logo'), png());

        expect(await screen.findByText(/Logo upload failed/)).toBeInTheDocument();
        expect(screen.queryByRole('img', { name: 'Logo' })).toBeNull();
    });

    it('an uploaded logo is already stored, so the form is not left "unsaved"', async () => {
        serveLogo('', (m) => (m === 'POST' ? respond(200, { success: true, logo: '/uploads/new.png' }) : null));
        const user = userEvent.setup();
        render(withQueryClient(<OrganisationSection user={USER} activeSection="info" />));

        await user.upload(await screen.findByLabelText('Upload Logo'), png());

        expect(await screen.findByText(/Logo uploaded/)).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Logo' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });
});

// ── Sign-in Method: one choice out of three, so one radio group.
describe('Sign-in Method', () => {
    it('is a radio group that reports and moves its choice', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<OrganisationSection user={USER} activeSection="auth" />));
        const group = await screen.findByRole('radiogroup', { name: 'Sign-in Method' });
        const radios = within(group).getAllByRole('radio');
        expect(radios).toHaveLength(3);
        expect(radios.filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(0);

        await user.click(within(group).getByRole('radio', { name: /Sign in with Google/ }));
        expect(within(group).getByRole('radio', { name: /Sign in with Google/ })).toHaveAttribute('aria-checked', 'true');

        await user.keyboard('{ArrowDown}');
        const microsoft = within(group).getByRole('radio', { name: /Sign in with Microsoft/ });
        expect(microsoft).toHaveAttribute('aria-checked', 'true');
        expect(microsoft).toHaveFocus();
    });

    it('locks the method once it is saved, not as soon as a card is picked', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<OrganisationSection user={USER} activeSection="auth" />));
        const group = await screen.findByRole('radiogroup', { name: 'Sign-in Method' });

        await user.click(within(group).getByRole('radio', { name: /Sign in with Google/ }));
        expect(screen.queryByText('Sign-in method is locked')).toBeNull();
        await user.click(within(group).getByRole('radio', { name: /Sign in with Microsoft/ }));

        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(puts).toHaveLength(1));
        expect(puts[0].body.authMethod).toBe('microsoft');
        expect(await screen.findByText('Sign-in method is locked')).toBeInTheDocument();
        expect(within(group).getByRole('radio', { name: /Sign in with Google/ })).toBeDisabled();
    });

    it('freezes the choice while the save is in flight, so the lock shows what the server stored', async () => {
        // The server keeps the first method it receives and ignores a later
        // one, so a pick made during the PUT would be shown as locked while
        // the organisation actually signs in with the other.
        let release: () => void = () => {};
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
            if ((init.method || 'GET') === 'PUT') {
                puts.push({ url: String(url), body: JSON.parse(String(init.body)) });
                await new Promise<void>(r => { release = r; });
                return respond(200, { success: true });
            }
            return base(url, init);
        });
        const user = userEvent.setup();
        render(withQueryClient(<OrganisationSection user={USER} activeSection="auth" />));
        const group = await screen.findByRole('radiogroup', { name: 'Sign-in Method' });
        const google = within(group).getByRole('radio', { name: /Sign in with Google/ });
        const microsoft = within(group).getByRole('radio', { name: /Sign in with Microsoft/ });

        await user.click(google);
        await user.click(screen.getByRole('button', { name: /Save changes|Saving/ }));
        await waitFor(() => expect(puts).toHaveLength(1));
        await user.click(microsoft);
        expect(google).toHaveAttribute('aria-checked', 'true');
        expect(microsoft).toHaveAttribute('aria-checked', 'false');

        release();
        expect(await screen.findByText('Sign-in method is locked')).toBeInTheDocument();
        expect(google).toHaveAttribute('aria-checked', 'true');
        expect(microsoft).toBeDisabled();
    });
});

// ── Allowed Domains: icon buttons need a name, and errors are read out.
describe('AllowedDomainsEditor', () => {
    function Harness() {
        const { t } = useTranslation();
        const [domains, setDomains] = React.useState<string[]>(['acme.nl']);
        return <AllowedDomainsEditor domains={domains} onChange={setDomains} t={t} />;
    }

    it('names its buttons and its input, and announces a refused domain', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<Harness />));
        const input = screen.getByRole('textbox', { name: 'Allowed Domains' });

        await user.type(input, 'acme.nl{Enter}');
        expect(screen.getByRole('alert')).toHaveTextContent('Domain "acme.nl" is already added');

        await user.clear(input);
        await user.type(input, 'not a domain');
        await user.click(screen.getByRole('button', { name: 'Add domain' }));
        expect(screen.getByRole('alert')).toHaveTextContent('Invalid domain format: "not a domain"');

        await user.click(screen.getByRole('button', { name: 'Remove acme.nl' }));
        expect(screen.queryByRole('button', { name: 'Remove acme.nl' })).toBeNull();
    });
});

// ── License & Usage (cloud): Stripe results, the near-cap CTA and the
// readouts that used to appear twice.
describe('License & Usage', () => {
    const CLOUD_USER = { ...USER, featureFlags: { deploymentMode: 'cloud' } };
    const serveCloud = (sub: Record<string, unknown> | null) => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url === '/auth/organizations') return respond(200, [ORG]);
            if (url === '/auth/groups') return respond(200, []);
            if (url === '/api/subscriptions/orgs/org1') return sub ? respond(200, sub) : respond(403, {});
            if (url === '/api/stripe/status') return respond(200, { enabled: true });
            if (url === '/api/stripe/plans') return respond(200, []);
            return respond(404, {});
        });
    };
    const NEAR_CAP = {
        plan_name: 'Team', status: 'active', stripe_subscription_id: 'sub_1',
        effective_limits: { max_cost_per_month: 100 }, current_usage: { cost: 90 },
    };
    const BUSINESS = { id: 'p2', name: 'Business', direction: 'upgrade', price: 99, currency: 'eur', billing_interval: 'monthly', has_stripe_price: true };

    afterEach(() => { window.history.replaceState({}, '', '/'); });

    it('reports a cancelled checkout on the licence page, not in the save bar', async () => {
        window.history.replaceState({}, '', '/app/settings/organisation/license?checkout=cancelled');
        serveCloud(null);
        render(withQueryClient(<OrganisationSection user={CLOUD_USER} activeSection="license" />));

        const note = await screen.findByText('Checkout was cancelled. No changes were made.');
        expect(note.closest('[role="alert"]')).not.toBeNull();
        expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
        expect(window.location.search).toBe('');
    });

    it('"Upgrade plan" near the cap opens the plan picker on this page', async () => {
        serveCloud({ ...NEAR_CAP, changeable_plans: [BUSINESS] });
        const user = userEvent.setup();
        render(withQueryClient(<OrganisationSection user={CLOUD_USER} activeSection="license" />));

        const cta = await screen.findByRole('button', { name: 'Upgrade plan' });
        expect(screen.queryByRole('link', { name: 'Upgrade plan' })).toBeNull();
        expect(screen.queryByText('Business')).toBeNull();
        await user.click(cta);
        expect(await screen.findByText('Business')).toBeInTheDocument();
    });

    it('without a plan to upgrade to, the near-cap banner offers no button', async () => {
        serveCloud({ ...NEAR_CAP, changeable_plans: [{ ...BUSINESS, direction: 'downgrade' }] });
        render(withQueryClient(<OrganisationSection user={CLOUD_USER} activeSection="license" />));

        expect(await screen.findByText(/You've used 90% of your AI usage budget/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Upgrade plan' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Upgrade plan' })).toBeNull();
    });

    it('reads AI usage out once, in "Usage this period"', async () => {
        serveCloud(NEAR_CAP);
        render(withQueryClient(<OrganisationSection user={CLOUD_USER} activeSection="license" />));

        expect(await screen.findByText('Usage this period')).toBeInTheDocument();
        expect(screen.queryByText('AI usage of cap this period')).toBeNull();
    });

    it('shows "Add user" and the seat hint once when the billing card carries them', async () => {
        serveCloud({
            plan_name: 'Team', status: 'active', stripe_subscription_id: 'sub_1',
            effective_limits: { max_users: 10 }, current_usage: {},
            billing: { subscription_total: 30, per_seat: true, seat_quantity: 3, plan_price: 10, plan_currency: 'eur', billing_interval: 'monthly' },
        });
        render(withQueryClient(<OrganisationSection user={CLOUD_USER} activeSection="license" />));

        expect(await screen.findByText('Plan limits')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Add user/ })).toHaveLength(1);
        expect(screen.getAllByText(/Inviting a user adds a seat/)).toHaveLength(1);
    });
});

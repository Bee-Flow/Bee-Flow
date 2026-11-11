import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AdminScopeBar from './AdminScopeBar';
import { scopeBarView, type ScopeBarInput } from './scopeBarView';
import type { AdminOrgChoice } from './useAdminOrg';

const ORGS = [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }];

function choiceOf(over: Partial<AdminOrgChoice> = {}): AdminOrgChoice {
    return {
        isPlatformAdmin: true, orgId: null, orgName: null, organizations: ORGS, organizationsLoaded: true, pending: false,
        homeOrganization: { id: 'org-a', name: 'Org A' }, setOrgId: vi.fn(), ...over,
    };
}

const bar = () => screen.getByTestId('admin-scope-bar');

/** Render the bar for one section kind and viewer, as the dashboard does. */
function renderBar(input: Partial<ScopeBarInput>, choice = choiceOf()) {
    const view = scopeBarView({ scope: 'mixed', isPlatformAdmin: choice.isPlatformAdmin, fixed: null, homeOrgName: choice.homeOrganization?.name ?? null, ...input });
    return render(<AdminScopeBar view={view} choice={choice} />);
}

describe('scope bar: whole-server sections', () => {
    it.each([true, false])('says "Whole server" and what a change does there (platform admin: %s)', (isPlatformAdmin) => {
        renderBar({ scope: 'instance', isPlatformAdmin }, choiceOf({ isPlatformAdmin }));
        expect(bar()).toHaveAttribute('data-kind', 'server');
        expect(bar()).toHaveTextContent('Whole server');
        expect(bar()).toHaveTextContent('Changes here apply to every organisation on this server');
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
});

describe('scope bar: personal sections', () => {
    it.each([true, false])('says it is only for the viewer (platform admin: %s)', (isPlatformAdmin) => {
        renderBar({ scope: 'user', isPlatformAdmin }, choiceOf({ isPlatformAdmin }));
        expect(bar()).toHaveAttribute('data-kind', 'personal');
        expect(bar()).toHaveTextContent('Personal: only for you');
    });
});

describe('scope bar: organisation sections', () => {
    it('gives a platform admin the picker, "All organisations" first, then every organisation by name', () => {
        renderBar({ scope: 'org' });
        const picker = screen.getByRole('combobox', { name: 'Organisation' });
        expect([...picker.querySelectorAll('option')].map(o => o.textContent)).toEqual(['All organisations', 'Org A', 'Org B']);
        expect(picker).toHaveValue('');
        expect(bar()).toHaveTextContent('Showing every organisation on this server');
    });

    it('names the chosen organisation in the sentence under the picker', () => {
        renderBar({ scope: 'mixed' }, choiceOf({ orgId: 'org-b', orgName: 'Org B' }));
        expect(screen.getByRole('combobox', { name: 'Organisation' })).toHaveValue('org-b');
        expect(bar()).toHaveTextContent('Showing Org B only');
    });

    it('hands a choice to the dashboard, and "All organisations" as null', async () => {
        const user = userEvent.setup();
        const setOrgId = vi.fn();
        renderBar({ scope: 'mixed' }, choiceOf({ setOrgId }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Organisation' }), 'Org B');
        expect(setOrgId).toHaveBeenLastCalledWith('org-b');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Organisation' }), 'All organisations');
        expect(setOrgId).toHaveBeenLastCalledWith(null);
    });

    it('gives an organisation admin the name of their organisation and no picker', () => {
        renderBar({ scope: 'mixed', isPlatformAdmin: false }, choiceOf({ isPlatformAdmin: false, organizations: [], homeOrganization: { id: 'org-a', name: 'Org A' } }));
        expect(bar()).toHaveAttribute('data-kind', 'org');
        expect(bar()).toHaveTextContent('Organisation: Org A');
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('falls back to "Your organisation" only when the name is missing', () => {
        renderBar({ scope: 'org', isPlatformAdmin: false, homeOrgName: null }, choiceOf({ isPlatformAdmin: false, homeOrganization: null }));
        expect(bar()).toHaveTextContent('Your organisation');
    });
});

describe('scope bar: sections that do not follow the picker', () => {
    it('Compliance: the own organisation by name, and for a platform admin why there is no picker', () => {
        const { unmount } = renderBar({ scope: 'org', fixed: 'home' });
        expect(bar()).toHaveTextContent('Organisation: Org A');
        expect(bar()).toHaveTextContent('Compliance shows your own organisation');
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        unmount();
        renderBar({ scope: 'org', fixed: 'home', isPlatformAdmin: false }, choiceOf({ isPlatformAdmin: false }));
        expect(bar()).toHaveTextContent('Organisation: Org A');
        expect(bar()).not.toHaveTextContent('Compliance shows your own organisation');
    });

    it('a list of every organisation says so instead of offering a choice', () => {
        renderBar({ scope: 'mixed', fixed: 'all' });
        expect(bar()).toHaveAttribute('data-kind', 'all-orgs');
        expect(bar()).toHaveTextContent('All organisations');
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
});

describe('scope bar: one organisation and every organisation look different', () => {
    const look = () => ({ reach: bar().getAttribute('data-reach'), icon: bar().querySelector('svg')?.getAttribute('data-icon') });

    it.each([
        ['the picker on all organisations', { scope: 'mixed' as const }, choiceOf(), 'all-orgs'],
        ['the picker on one organisation', { scope: 'mixed' as const }, choiceOf({ orgId: 'org-b', orgName: 'Org B' }), 'one-org'],
        ['a list of every organisation', { scope: 'mixed' as const, fixed: 'all' as const }, choiceOf(), 'all-orgs'],
        ["an organisation admin's organisation", { scope: 'mixed' as const, isPlatformAdmin: false }, choiceOf({ isPlatformAdmin: false }), 'one-org'],
        ['the whole server', { scope: 'instance' as const }, choiceOf(), 'server'],
        ['the own account', { scope: 'user' as const }, choiceOf(), 'personal'],
    ])('%s: its own icon and surface', (_name, input, choice, reach) => {
        renderBar(input, choice);
        expect(look()).toEqual({ reach, icon: reach });
    });

    it('switching the picker from all organisations to one changes the icon and the surface', () => {
        const view = scopeBarView({ scope: 'mixed', isPlatformAdmin: true, fixed: null, homeOrgName: null });
        const { rerender } = render(<AdminScopeBar view={view} choice={choiceOf()} />);
        const before = bar().className;
        expect(look().icon).toBe('all-orgs');
        rerender(<AdminScopeBar view={view} choice={choiceOf({ orgId: 'org-b', orgName: 'Org B' })} />);
        expect(look().icon).toBe('one-org');
        expect(bar().className).not.toBe(before);
    });
});

// The directory under the admin dashboard's chosen organisation: one
// organisation counted and shown, and no second organisation filter that
// could disagree with the dashboard bar.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import PeopleDirectory from './PeopleDirectory';
import { omitted, stub } from '@/test/mocks';

type Props = ComponentProps<typeof PeopleDirectory>;

const ORGS = [
    { id: 'orgA', name: 'Acme B.V.', status: 'active' },
    { id: 'orgB', name: 'Beta N.V.', status: 'active' },
    { id: 'orgC', name: 'Gamma', status: 'active' },
];
const GROUPS = [{ id: 'g_beta', name: 'Beta team', organizationId: 'orgB' }];
// Home in A, and in B through a group: the server lists them for B.
const MULTI = { id: 'u_multi', username: 'multi', displayName: 'Multi Org', email: 'm@example.test', orgRole: 'member', organizationId: 'orgA', groups: ['g_beta'], status: 'active' };
const BEA = { id: 'u_bea', username: 'bea', displayName: 'Bea Smit', email: 'b@example.test', orgRole: 'member', organizationId: 'orgB', groups: [], status: 'active' };

const renderDir = (props: Partial<Props> = {}) => render(
    <PeopleDirectory {...omitted<Props>()}
        users={stub<Props['users']>([MULTI, BEA])}
        groups={stub<Props['groups']>(GROUPS)}
        organizations={ORGS}
        viewerHomeOrgId={null}
        {...props}
    />,
);

describe('PeopleDirectory with the dashboard organisation', () => {
    it('one organisation chosen: no organisation count, filter or grouping that would only repeat its name', () => {
        renderDir({ scopeOrgId: 'orgB' });
        expect(screen.getByTestId('people-summary')).toHaveTextContent(/^2 people · 1 group$/);
        expect(screen.queryByRole('heading', { name: 'Beta N.V.' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Acme B.V.' })).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Beta team' })).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'All organisations' })).not.toBeInTheDocument();
        expect(screen.queryByRole('radio', { name: 'By organisation' })).not.toBeInTheDocument();
    });

    it('a viewer with one organisation: the same, without a dashboard choice', () => {
        renderDir({ organizations: [ORGS[1]] });
        expect(screen.getByTestId('people-summary')).toHaveTextContent(/^2 people · 1 group$/);
        expect(screen.queryByRole('combobox', { name: 'All organisations' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Beta N.V.' })).not.toBeInTheDocument();
    });

    it('all organisations: every organisation counted and the organisation filter offered', () => {
        renderDir();
        expect(screen.getByTestId('people-summary')).toHaveTextContent(/^2 people · 3 organisations · 1 group$/);
        expect(screen.getByRole('heading', { name: 'Acme B.V.' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'All organisations' })).toBeInTheDocument();
    });
});

describe('PeopleDirectory counts and roles', () => {
    it('says one of each in the singular', () => {
        renderDir({ users: stub<Props['users']>([BEA]), organizations: [ORGS[1]] });
        expect(screen.getByTestId('people-summary')).toHaveTextContent(/^1 person · 1 group$/);
    });

    it('names the roles the same way: an account without an organisation role reads as a member', () => {
        const admin = { ...BEA, id: 'u_admin', username: 'ada', displayName: 'Ada Admin', orgRole: 'org_admin' };
        const plain = { ...BEA, id: 'u_plain', username: 'pim', displayName: 'Pim Plain', orgRole: undefined, role: 'user', status: 'pending' };
        renderDir({ users: stub<Props['users']>([admin, BEA, plain]) });
        expect(screen.getAllByTestId('people-role').map(n => n.textContent).sort()).toEqual(['Member', 'Member', 'Organisation admin']);
    });
});

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
    it('one organisation chosen: counted as one, listed under it only, without its own organisation filter', () => {
        renderDir({ scopeOrgId: 'orgB' });
        expect(screen.getByText('2 people · 1 organisations · 1 groups')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Beta N.V.' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Acme B.V.' })).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'All organisations' })).not.toBeInTheDocument();
    });

    it('all organisations: every organisation counted and the organisation filter offered', () => {
        renderDir();
        expect(screen.getByText('2 people · 3 organisations · 1 groups')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Acme B.V.' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'All organisations' })).toBeInTheDocument();
    });
});

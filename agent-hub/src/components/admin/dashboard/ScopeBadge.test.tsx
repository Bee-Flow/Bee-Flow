import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ScopeBadge from './ScopeBadge';
import type { AdminScope } from './adminTabs';

const badge = () => screen.getByTestId('admin-scope-badge');

describe('ScopeBadge', () => {
    it('says "Whole server" for the instance scope, with its tooltip, whoever looks', () => {
        render(<ScopeBadge scope="instance" isPlatformAdmin={false} />);
        expect(badge()).toHaveTextContent('Whole server');
        expect(badge()).toHaveAttribute('title', 'Applies to every organisation on this server');
    });

    it('says "Personal" for the user scope', () => {
        render(<ScopeBadge scope="user" isPlatformAdmin />);
        expect(badge()).toHaveTextContent('Personal');
    });

    it('names the organisation when the name is known, else says "Your organisation"', () => {
        const { rerender } = render(<ScopeBadge scope="org" isPlatformAdmin={false} orgName="Acme" />);
        expect(badge()).toHaveTextContent('Organisation: Acme');
        rerender(<ScopeBadge scope="org" isPlatformAdmin={false} />);
        expect(badge()).toHaveTextContent('Your organisation');
        rerender(<ScopeBadge scope="org" isPlatformAdmin orgName={null} />);
        expect(badge()).toHaveTextContent('Your organisation');
    });

    it.each<[boolean, string]>([[true, 'All organisations'], [false, 'Your organisation']])(
        'a mixed section reads differently per viewer (platform admin: %s)',
        (isPlatformAdmin, text) => {
            render(<ScopeBadge scope="mixed" isPlatformAdmin={isPlatformAdmin} />);
            expect(badge()).toHaveTextContent(text);
            expect(badge()).toHaveAttribute('data-scope', 'mixed' satisfies AdminScope);
        },
    );

    it('a mixed section for a member of several organisations says "Your organisations"', () => {
        render(<ScopeBadge scope="mixed" isPlatformAdmin={false} multiOrg />);
        expect(badge()).toHaveTextContent('Your organisations');
        expect(badge()).toHaveAttribute('title', 'Shows the organisations you belong to');
    });

    it('a platform admin still reads "All organisations" when multiOrg is set', () => {
        render(<ScopeBadge scope="mixed" isPlatformAdmin multiOrg />);
        expect(badge()).toHaveTextContent('All organisations');
    });
});

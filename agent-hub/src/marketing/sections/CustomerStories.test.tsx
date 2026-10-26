/**
 * Customer stories grid: cards from the inlined items, the sector filter, and
 * nothing at all when there is nothing to show.
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/CustomerStories.test.tsx
 */
import React from 'react';
import { screen } from '@testing-library/react';
import { renderWithClient } from '../../test/render';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import CustomerStories from './CustomerStories';

const item = (id: string, sectorId: string, sector: string) => ({
    id, slug: id, href: `/${id}`, customer: `Customer ${id}`, sector, sectorId, title: `Story ${id}`, lead: `Lead ${id}`,
    quote: '', quoteBy: '', logo: { src: '', srcDark: '', alt: '' }, metrics: [{ stat: '60%', label: 'faster' }, { stat: '2x', label: 'more' }, { stat: '9', label: 'third' }],
});

const data = {
    enabled: true,
    title: 'Customers',
    linkLabel: 'Read the story',
    items: [item('a', 'fin', 'Finance'), item('b', 'pub', 'Public'), item('c', 'fin', 'Finance')],
};

afterEach(() => window.history.replaceState({}, '', '/'));

describe('CustomerStories', () => {
    it('draws one linked card per story, with at most two figures', () => {
        renderWithClient(<CustomerStories data={data} />);
        const link = screen.getByRole('link', { name: 'Customer a: Story a' });
        expect(link.getAttribute('href')).toBe('/a');
        expect(screen.getAllByRole('article')).toHaveLength(3);
        expect(screen.queryByText('third')).toBeNull();
    });

    it('filters by sector and keeps the filter an accessible pressed-state group', async () => {
        renderWithClient(<CustomerStories data={data} />);
        const all = screen.getByRole('button', { name: 'All' });
        expect(all.getAttribute('aria-pressed')).toBe('true');
        await userEvent.click(screen.getByRole('button', { name: 'Public' }));
        expect(screen.getAllByRole('article')).toHaveLength(1);
        expect(screen.getByRole('button', { name: 'Public' }).getAttribute('aria-pressed')).toBe('true');
        await userEvent.click(all);
        expect(screen.getAllByRole('article')).toHaveLength(3);
    });

    it('has no filter for one sector, or when switched off', () => {
        const { unmount } = renderWithClient(<CustomerStories data={{ ...data, items: [item('a', 'fin', 'Finance')] }} />);
        expect(screen.queryByRole('button')).toBeNull();
        unmount();
        renderWithClient(<CustomerStories data={{ ...data, showFilter: false }} />);
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders nothing without stories on the published site, a scaffold in the editor', () => {
        expect(renderWithClient(<CustomerStories data={{ enabled: true, items: [] }} />).container.innerHTML).toBe('');
        window.history.replaceState({}, '', '/?preview=1');
        const { container } = renderWithClient(<CustomerStories data={{ enabled: true, items: [] }} />);
        expect(container.querySelector('.story-empty')).not.toBeNull();
    });

    it('renders nothing when disabled', () => {
        expect(renderWithClient(<CustomerStories data={{ ...data, enabled: false }} />).container.innerHTML).toBe('');
    });
});

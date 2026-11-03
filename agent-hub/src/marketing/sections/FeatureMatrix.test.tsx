/**
 * Feature matrix section (issue #529): groups, N columns, the highlighted
 * column, accessible check/dash text, cells matched by column id, the phone
 * column picker, and what the published site drops.
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/FeatureMatrix.test.tsx
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import FeatureMatrix from './FeatureMatrix';

const cell = (id: string, kind: string, text = '') => ({ id, kind, text });

const base = {
    enabled: true,
    title: 'Compare the plans',
    columns: [
        { id: 'col-free', label: 'Free', highlight: false },
        { id: 'col-pro', label: 'Pro', highlight: true },
        { id: 'col-ent', label: 'Enterprise', highlight: false },
    ],
    groups: [
        {
            id: 'grp-core', title: 'Core',
            rows: [
                { id: 'r1', label: 'Agents', cells: [cell('col-free', 'included'), cell('col-pro', 'included'), cell('col-ent', 'included')] },
                { id: 'r2', label: 'Seats', cells: [cell('col-free', 'text', 'Up to 3'), cell('col-pro', 'text', 'Unlimited'), cell('col-ent', 'text', 'Unlimited')] },
            ],
        },
        {
            id: 'grp-sec', title: 'Security',
            rows: [{ id: 'r3', label: 'SSO', cells: [cell('col-free', 'excluded'), cell('col-pro', 'excluded'), cell('col-ent', 'included')] }],
        },
    ],
    footnote: 'Per licence.',
};

afterEach(() => window.history.replaceState(null, '', '/'));

describe('FeatureMatrix', () => {
    it('renders a real table with the plan heads, a row per feature and a header row per group', () => {
        const { container } = render(<FeatureMatrix data={base} />);
        const heads = container.querySelectorAll('thead th[scope="col"]');
        expect([...heads].map((h) => h.textContent)).toEqual(['', 'Free', 'Pro', 'Enterprise']);
        expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Agents', 'Seats', 'SSO']);
        const groups = container.querySelectorAll('th[scope="colgroup"]');
        expect([...groups].map((g) => g.textContent)).toEqual(['Core', 'Security']);
        groups.forEach((g) => expect(g.getAttribute('colspan')).toBe('4'));
        expect(container.querySelectorAll('tbody')).toHaveLength(2);
        expect(container.querySelector('.fm-footnote')?.textContent).toBe('Per licence.');
    });

    it('supports two up to six columns', () => {
        const two = { ...base, columns: base.columns.slice(0, 2) };
        const { container, rerender } = render(<FeatureMatrix data={two} />);
        expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
        const six = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: `P${i}` }));
        rerender(<FeatureMatrix data={{ ...base, columns: six, groups: [{ id: 'g', title: 'G', rows: [{ id: 'r', label: 'F', cells: six.map((c) => cell(c.id, 'included')) }] }] }} />);
        expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(7);
        expect(container.querySelectorAll('tbody td')).toHaveLength(6);
    });

    it('marks the highlighted column on its head and on every cell of it', () => {
        const { container } = render(<FeatureMatrix data={base} />);
        expect(container.querySelectorAll('.fm-col--highlight')).toHaveLength(1);
        expect(container.querySelector('.fm-col--highlight')?.textContent).toBe('Pro');
        expect(container.querySelectorAll('td.fm-cell--highlight')).toHaveLength(3);
    });

    it('says "Included" / "Not included" in visually hidden text and hides the icons from assistive technology', () => {
        const { container } = render(<FeatureMatrix data={base} />);
        const agents = within(screen.getByRole('row', { name: /Agents/ }));
        expect(agents.getAllByText('Included')).toHaveLength(3);
        const sso = within(screen.getByRole('row', { name: /SSO/ }));
        expect(sso.getAllByText('Not included')).toHaveLength(2);
        container.querySelectorAll('.fm-mark svg').forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
        expect(container.querySelector('.fm-mark .fm-sr')).not.toBeNull();
    });

    it('uses the authored words for the marks', () => {
        render(<FeatureMatrix data={{ ...base, includedLabel: 'Inbegrepen', excludedLabel: 'Niet inbegrepen' }} />);
        expect(screen.getAllByText('Inbegrepen').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Niet inbegrepen').length).toBeGreaterThan(0);
        expect(screen.queryByText('Included')).toBeNull();
    });

    it('shows text cells and matches cells to their column by id, not by position', () => {
        const reordered = {
            ...base,
            groups: [{
                id: 'g', title: 'Core',
                rows: [{ id: 'r2', label: 'Seats', cells: [cell('col-ent', 'text', 'Custom'), cell('col-free', 'text', 'Up to 3')] }],
            }],
        };
        render(<FeatureMatrix data={reordered} />);
        const cells = within(screen.getByRole('row', { name: /Seats/ })).getAllByRole('cell');
        expect(cells.map((c) => c.textContent)).toEqual(['Up to 3', '', 'Custom']);
    });

    it('drops empty rows and empty groups on the published site, and renders nothing without content', () => {
        const withEmpty = {
            ...base,
            groups: [...base.groups, { id: 'g3', title: 'Empty group', rows: [{ id: 'x', label: ' ', cells: [cell('col-free', 'text', ' ')] }] }],
        };
        const { container, rerender } = render(<FeatureMatrix data={withEmpty} />);
        expect(container.querySelectorAll('tbody')).toHaveLength(2);
        expect(screen.queryByText('Empty group')).toBeNull();
        rerender(<FeatureMatrix data={{ ...base, groups: [] }} />);
        expect(container.firstChild).toBeNull();
        rerender(<FeatureMatrix data={{ ...base, columns: [] }} />);
        expect(container.firstChild).toBeNull();
        rerender(<FeatureMatrix data={{ ...base, enabled: false }} />);
        expect(container.firstChild).toBeNull();
    });

    it('keeps every slot in the editor preview', () => {
        window.history.replaceState(null, '', '/?preview=1');
        const { container } = render(<FeatureMatrix data={{ ...base, groups: [{ id: 'g', title: '', rows: [{ id: 'r', label: '', cells: [] }] }], footnote: '' }} />);
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(container.querySelector('.fm-footnote')).not.toBeNull();
    });
});

describe('FeatureMatrix phone picker', () => {
    const buttons = () => within(screen.getByRole('group', { name: 'Choose a plan' })).getAllByRole('button');

    it('offers one button per plan and starts on the highlighted plan', () => {
        const { container } = render(<FeatureMatrix data={base} />);
        expect(buttons().map((b) => b.textContent)).toEqual(['Free', 'Pro', 'Enterprise']);
        expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
        expect(container.querySelectorAll('td.fm-cell--selected')).toHaveLength(3);
        expect(container.querySelector('th.fm-col--selected')?.textContent).toBe('Pro');
    });

    it('starts on the first plan when none is highlighted', () => {
        const noHighlight = { ...base, columns: base.columns.map((c) => ({ ...c, highlight: false })) };
        render(<FeatureMatrix data={noHighlight} />);
        expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    });

    it('switches the visible column when another plan is picked', async () => {
        const { container } = render(<FeatureMatrix data={base} />);
        await userEvent.click(screen.getByRole('button', { name: 'Enterprise' }));
        expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
        expect(container.querySelector('th.fm-col--selected')?.textContent).toBe('Enterprise');
        const sso = screen.getByRole('row', { name: /SSO/ });
        const selected = [...sso.querySelectorAll('td')].filter((td) => td.classList.contains('fm-cell--selected'));
        expect(selected).toHaveLength(1);
        expect(selected[0].textContent).toBe('Included');
        // every column stays in the DOM: the phone layout hides them with CSS only
        expect(sso.querySelectorAll('td')).toHaveLength(3);
    });

    it('uses the authored picker label', () => {
        render(<FeatureMatrix data={{ ...base, pickerLabel: 'Kies een licentie' }} />);
        expect(screen.getByRole('group', { name: 'Kies een licentie' })).toBeInTheDocument();
    });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import CategoryMatrix from './CategoryMatrix';

/**
 * The matrix that replaced three separate 21-item grids, now as ONE table.
 *
 * The load-bearing test is `half protected`: the reason the three grids became
 * one table is that "we look for this, and then let every tool carry it out"
 * was invisible while the questions lived on two different panes.
 */

const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    let out = hasStringFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
            out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
        }
    }
    return out;
};

const CATEGORIES = [
    { id: 'Person', group: 'Personal', label: 'Person names' },
    { id: 'Email', group: 'Contact', label: 'Email addresses' },
    { id: 'IBAN', group: 'Financial', label: 'IBAN numbers' },
    { id: 'Organization', group: 'Organization', label: 'Company names' },
];

type Props = React.ComponentProps<typeof CategoryMatrix>;

function setup(over: Partial<Props> = {}) {
    const props: Props = {
        categories: CATEGORIES,
        detect: ['Person', 'Email'],
        toolPolicy: { external: { blockCategories: ['Person'] }, internal: { blockCategories: [] } },
        canBlockExternal: true,
        allowPublicOrgs: true,
        readOnly: false,
        toolKinds: null,
        onToggleDetect: vi.fn(),
        onSetDetect: vi.fn(),
        onToggleTool: vi.fn(),
        t,
        ...over,
    };
    render(<CategoryMatrix {...props} />);
    return props;
}

const header = (name: RegExp) => screen.getByRole('columnheader', { name });

describe('CategoryMatrix', () => {
    it('asks all three questions on one row, per kind, in one table', () => {
        setup();
        const table = screen.getByRole('table', { name: /kind of personal data/i });
        expect(within(table).getAllByRole('rowheader')).toHaveLength(4);
        expect(within(table).getAllByRole('checkbox')).toHaveLength(12);
        expect(header(/Hide from AI/)).toBeInTheDocument();
        expect(header(/Hold back · outside tools/)).toBeInTheDocument();
        expect(header(/Hold back · own server/)).toBeInTheDocument();
    });

    it('opens each group with its name and how many of its kinds are hidden', () => {
        setup();
        const groups = screen.getAllByRole('columnheader')
            .filter(h => h.getAttribute('colspan') === '4')
            .map(h => h.textContent);
        expect(groups).toEqual([
            'Personal1 of 1 hidden', 'Contact1 of 1 hidden', 'Financial0 of 1 hidden', 'Organisation0 of 1 hidden',
        ]);
    });

    it('reflects each column against its own stored list', () => {
        setup();
        expect(screen.getByRole('checkbox', { name: 'Person names — Hide from AI' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Person names — Outside tools' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Person names — Own server' })).not.toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'IBAN numbers — Hide from AI' })).not.toBeChecked();
    });

    it('counts each column in its header', () => {
        setup();
        expect(header(/Hide from AI/)).toHaveTextContent('look for it · 2 of 4');
        expect(header(/outside tools/)).toHaveTextContent('1 of 4');
        expect(header(/outside tools/)).not.toHaveTextContent('anything may leave');
        expect(header(/own server/)).toHaveTextContent('0 of 4');
    });

    it('says so when no kind is held back from outside tools', () => {
        setup({ toolPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } } });
        expect(header(/outside tools/)).toHaveTextContent('0 of 4 — anything may leave');
    });

    it('routes a click to the handler for that column', async () => {
        const user = userEvent.setup();
        const props = setup();

        await user.click(screen.getByRole('checkbox', { name: 'IBAN numbers — Hide from AI' }));
        expect(props.onToggleDetect).toHaveBeenCalledWith('IBAN', true);

        await user.click(screen.getByRole('checkbox', { name: 'IBAN numbers — Own server' }));
        expect(props.onToggleTool).toHaveBeenCalledWith('internal', 'IBAN', true);

        await user.click(screen.getByRole('checkbox', { name: 'Person names — Outside tools' }));
        expect(props.onToggleTool).toHaveBeenCalledWith('external', 'Person', false);
    });

    it('sets the look-for column as a whole with All and None', async () => {
        const user = userEvent.setup();
        const props = setup();
        await user.click(screen.getByRole('button', { name: 'All' }));
        expect(props.onSetDetect).toHaveBeenLastCalledWith(['Person', 'Email', 'IBAN', 'Organization']);
        await user.click(screen.getByRole('button', { name: 'None' }));
        expect(props.onSetDetect).toHaveBeenLastCalledWith([]);
    });

});

describe('CategoryMatrix findings and states', () => {
    it('names the kinds it looks for but lets every tool carry out', () => {
        // Email is detected and appears in neither tool list.
        setup();
        expect(screen.getByText(/1 kinds are only half protected/)).toBeInTheDocument();
        expect(screen.getByText(/no tool holds them back/)).toBeInTheDocument();
    });

    it('stays quiet while the tool lists are untouched', () => {
        setup({ toolPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } } });
        expect(screen.queryByText(/half protected/)).toBeNull();
    });

    it('locks the outside-tools column without hiding it', () => {
        // Locked is not hidden: an admin has to see what they are not buying.
        setup({ canBlockExternal: false });
        expect(screen.getByText(/Holding data back from outside tools is an Enterprise feature/)).toBeInTheDocument();
        expect(header(/outside tools/)).toHaveTextContent('1 of 4 · Enterprise');
        // Not the "anything may leave" nudge either: there is nothing to tick.
        expect(header(/outside tools/)).not.toHaveTextContent('anything may leave');
        expect(screen.getAllByRole('checkbox')).toHaveLength(8);
    });

    it('names the public-organisation list on the row it applies to', () => {
        setup();
        expect(screen.getByRole('rowheader', { name: /Company names/ }))
            .toHaveTextContent('221 well-known companies are never hidden');
        expect(screen.getByRole('rowheader', { name: /Email addresses/ }))
            .not.toHaveTextContent('well-known');
    });

    it('drops that note when the built-in list is off', () => {
        setup({ allowPublicOrgs: false });
        expect(screen.queryByText(/well-known companies/)).toBeNull();
    });

    it('shows what left with tools, per kind, when the last 30 days are known', () => {
        setup({ toolKinds: { Person: 33, Email: 0 } });
        const person = screen.getByRole('checkbox', { name: 'Person names — Outside tools' }).closest('td');
        expect(person).toHaveTextContent('33 left with tools');
        expect(screen.getAllByText(/left with tools/)).toHaveLength(1);
    });

    it('shows nothing, not a zero, when the last 30 days are unknown', () => {
        setup({ toolKinds: null });
        expect(screen.queryByText(/left with tools/)).toBeNull();
    });

    it('disables every box and both bulk buttons in read-only mode', () => {
        setup({ readOnly: true });
        for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
        expect(screen.getByRole('button', { name: 'All' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'None' })).toBeDisabled();
    });
});

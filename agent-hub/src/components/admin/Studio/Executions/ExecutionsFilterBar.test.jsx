import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import ExecutionsFilterBar from './ExecutionsFilterBar';

const baseFilters = { status: 'all', range: '24h', trigger: null, automationId: null, mode: 'live' };

const renderBar = (props = {}) =>
    render(
        <ExecutionsFilterBar
            filters={baseFilters}
            setFilters={vi.fn()}
            facets={null}
            onRefresh={vi.fn()}
            {...props}
        />,
    );

/** The next filters an updater passed to setFilters produces from `from`. */
const applied = (setFilters, from = baseFilters) => setFilters.mock.calls.at(-1)[0](from);

beforeEach(() => cleanup());

describe('ExecutionsFilterBar: status pills and period', () => {
    it('names the statuses in the builder Runs tab\'s words, beside the period', () => {
        renderBar();
        const pills = within(screen.getByRole('group', { name: 'Show runs' }));
        for (const label of ['All', 'Finished', 'Failed', 'Running', 'Waiting for someone', 'Stopped']) {
            expect(pills.getByRole('button', { name: label })).toBeTruthy();
        }
        const period = within(screen.getByRole('group', { name: 'Period' }));
        for (const label of ['24h', '7d', '30d', 'All']) {
            expect(period.getByRole('button', { name: label })).toBeTruthy();
        }
    });

    it('counts each pill from facets.status', () => {
        const facets = { status: { success: 3, error: 1, running: 2, queued: 1, awaiting_approval: 1 } };
        renderBar({ facets });
        const pills = within(screen.getByRole('group', { name: 'Show runs' }));
        // Running = running(2) + queued(1); All = every status together.
        expect(pills.getByRole('button', { name: /Running/ }).textContent).toMatch(/3/);
        expect(pills.getByRole('button', { name: /Failed/ }).textContent).toMatch(/1/);
        expect(pills.getByRole('button', { name: /Finished/ }).textContent).toMatch(/3/);
        expect(pills.getByRole('button', { name: /^All/ }).textContent).toMatch(/8/);
    });

    it('sets the status and the period through an updater', async () => {
        const setFilters = vi.fn();
        renderBar({ setFilters });
        await userEvent.click(screen.getByRole('button', { name: 'Failed' }));
        expect(applied(setFilters)).toEqual({ ...baseFilters, status: 'error' });
        await userEvent.click(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: '7d' }));
        expect(applied(setFilters)).toEqual({ ...baseFilters, range: '7d' });
    });

    it('says what the counts cover when the period is all time', () => {
        renderBar({ filters: { ...baseFilters, range: 'all' } });
        expect(screen.getByText('Counts cover the last 30 days.')).toBeTruthy();
    });
});

describe('ExecutionsFilterBar: automation picker', () => {
    it('offers the automations when showAutomationPicker is true', () => {
        renderBar({ showAutomationPicker: true, automationOptions: [{ id: 'a1', title: 'Auto One' }] });
        expect(screen.getByRole('option', { name: 'Auto One' })).toBeTruthy();
    });

    it('does not render the picker when showAutomationPicker is false', () => {
        renderBar({ showAutomationPicker: false, automationOptions: [{ id: 'a1', title: 'Auto One' }] });
        expect(screen.queryByRole('option', { name: 'Auto One' })).toBeNull();
    });
});

describe('ExecutionsFilterBar: the folded filters on a laptop', () => {
    it('names what the Filter button narrows, and clears it back to the defaults', async () => {
        const setFilters = vi.fn();
        const filters = { ...baseFilters, trigger: 'schedule', mode: 'dry_run' };
        renderBar({ filters, setFilters });
        const button = screen.getByTestId('executions-filter-button');
        expect(button.textContent).toBe('Filter: On a schedule · Tests only');

        await userEvent.click(button);
        const panel = screen.getByTestId('executions-filter-panel');
        expect(within(panel).getByRole('combobox', { name: 'Filter by trigger' })).toBeTruthy();
        await userEvent.click(within(panel).getByRole('button', { name: /Clear filters/ }));
        expect(applied(setFilters, filters)).toEqual({ ...filters, trigger: null, mode: 'live', automationId: null });
    });

    it('opens a pasted run link from the link icon', async () => {
        const onOpenRunById = vi.fn();
        renderBar({ onOpenRunById });
        await userEvent.click(screen.getByTestId('executions-jump-button'));
        const box = screen.getAllByRole('textbox', { name: 'Paste a run link or id' }).at(-1);
        await userEvent.type(box, 'https://example.test/app?view=runs&run=run_abc123{Enter}');
        expect(onOpenRunById).toHaveBeenCalledWith('run_abc123');
    });
});

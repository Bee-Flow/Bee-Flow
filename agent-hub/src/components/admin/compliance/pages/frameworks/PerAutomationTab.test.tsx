import { screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import PerAutomationTab from './PerAutomationTab';

/**
 * The AI Act register keeps the assessment of a removed automation or agent
 * (it is part of the record), but lists it only under "Removed", named for
 * what it was: never its raw id.
 */

const ROWS = [
    { target_kind: 'automation', target_id: 'au-live', title: 'Letters', target_state: 'live', outcome: 'minimal', attested_at: '2026-10-01T00:00:00Z', expires_at: '2027-10-01T00:00:00Z', current: true },
    { target_kind: 'automation', target_id: 'au-trash', title: 'Old letters', target_state: 'trashed', outcome: 'transparency', attested_at: '2026-09-01T00:00:00Z', expires_at: '2027-09-01T00:00:00Z', current: true },
    { target_kind: 'automation', target_id: 'au-gone-7f3a', title: null, target_state: 'gone', outcome: 'minimal', attested_at: '2026-08-01T00:00:00Z', expires_at: '2025-08-01T00:00:00Z', current: false },
    { target_kind: 'agent', target_id: 'ag-gone-91c2', title: null, target_state: 'gone', outcome: 'transparency', attested_at: '2026-08-01T00:00:00Z', expires_at: null, current: true },
];

function install(rows: unknown[]) {
    setDemoTransport(async () => new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => install(ROWS));
afterEach(() => { cleanup(); setDemoTransport(null); });

const titles = () => screen.getAllByTestId('fw-per-automation-title').map((el) => el.textContent);

describe('PerAutomationTab — removed targets', () => {
    it('lists live targets by default; the removed ones sit behind the Removed filter', async () => {
        renderWithClient(<PerAutomationTab />);
        expect(await screen.findByText('Letters')).toBeTruthy();
        expect(titles()).toEqual(['Letters']);
        expect(screen.queryByText('Old letters')).toBeNull();
        expect(screen.getAllByTestId('fw-per-automation-open')).toHaveLength(1);

        const filter = within(screen.getByTestId('fw-per-automation-view'));
        await userEvent.click(filter.getByRole('radio', { name: /Removed/ }));

        expect(titles()).toEqual(['Old letters', 'Deleted automation', 'Deleted agent']);
        expect(screen.getByTestId('fw-per-automation-trashed').textContent).toBe('In trash');
        // never a raw id as a name, and no way to open a target that is gone
        expect(screen.queryByText(/au-gone-7f3a|ag-gone-91c2|au-trash/)).toBeNull();
        expect(screen.queryByTestId('fw-per-automation-open')).toBeNull();

        await userEvent.click(filter.getByRole('radio', { name: /Current/ }));
        expect(titles()).toEqual(['Letters']);
    });

    it('shows no filter while nothing was removed; a row from an older server counts as live', async () => {
        install([{ target_kind: 'automation', target_id: 'au-1', title: 'Letters', outcome: 'minimal', attested_at: '2026-10-01T00:00:00Z', expires_at: null, current: true }]);
        renderWithClient(<PerAutomationTab />);
        expect(await screen.findByText('Letters')).toBeTruthy();
        expect(screen.queryByTestId('fw-per-automation-view')).toBeNull();
    });
});

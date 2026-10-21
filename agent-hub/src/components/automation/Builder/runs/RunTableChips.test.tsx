import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { authFetch } from '../../../../utils/helpers';
import { withQueryClient } from '../../../../test/queryWrapper';
import RunTableChips from './RunTableChips';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const ID1 = 'rtb_0123456789abcdef0123456789abcdef';
const ID2 = 'rtb_fedcba9876543210fedcba9876543210';

const handle = (over: Record<string, unknown> = {}) => ({
    kind: 'table', tableId: ID1, runId: 'run-early', name: 'Scores per region', rowCount: 120,
    columns: [{ key: 'region', label: 'Region', type: 'text' }, { key: 'n', label: 'Answers', type: 'number' }],
    preview: [], expiresAt: null, provenance: null, ...over,
});

const page = {
    name: 'Scores per region', runId: 'run-early', rowCount: 120, offset: 0, limit: 50, hasMore: true, expiresAt: null,
    columns: [{ key: 'region', label: 'Region', type: 'text' }],
    rows: [{ region: 'North' }],
};

beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => page } as unknown as Response);
});
afterEach(cleanup);

const mount = (output: unknown, runId: string | null = 'run-step') => render(withQueryClient(<RunTableChips runId={runId} output={output} />));

describe('RunTableChips', () => {
    it('renders nothing for a step that kept no table', () => {
        const { container } = mount({ text: 'hello' });
        expect(container.innerHTML).toBe('');
    });

    it('renders nothing for a dry run placeholder', () => {
        const { container } = mount({ table: handle({ tableId: 'dry-run' }) });
        expect(container.innerHTML).toBe('');
    });

    it('shows one chip per table with its name and size', () => {
        mount({ table: handle(), tables: [handle(), handle({ tableId: ID2, name: 'Second sheet', rowCount: 1, columns: [] })] });
        const chips = screen.getAllByTestId('run-table-chip');
        expect(chips).toHaveLength(2);
        expect(chips[0].textContent).toContain('Scores per region');
        expect(chips[0].textContent).toContain('120 rows · 2 columns');
        expect(chips[1].textContent).toContain('Second sheet');
    });

    it('opens the table from the run that wrote it, and closes it again', async () => {
        const user = userEvent.setup();
        mount({ table: handle() });
        await user.click(screen.getByRole('button', { name: 'Open table: Scores per region' }));
        expect(await screen.findByText('North')).toBeTruthy();
        expect(screen.getByTestId('run-table-view')).toBeTruthy();
        expect(vi.mocked(authFetch).mock.calls[0][0]).toContain('/runs/run-early/tables/');
        await user.keyboard('{Escape}');
        expect(screen.queryByTestId('run-table-view')).toBeNull();
    });

    it('uses the run of the step when the handle names none, and shows nothing when there is neither', () => {
        mount({ table: handle({ runId: null }) });
        expect(screen.getAllByTestId('run-table-chip')).toHaveLength(1);
        cleanup();
        const { container } = mount({ table: handle({ runId: null }) }, null);
        expect(container.innerHTML).toBe('');
    });
});

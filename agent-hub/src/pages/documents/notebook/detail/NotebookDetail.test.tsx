import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../../api/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), apiClient: { get: h.get }, default: { get: h.get } }));
vi.mock('./NotebookEditorView', () => ({ default: ({ data }: { data: { notebook: { name: string } } }) => <div data-testid="view">{data.notebook.name}</div> }));

import NotebookDetail from './NotebookDetail';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const renderDetail = (onBack = vi.fn()) => {
    render(withQueryClient(<NotebookDetail notebookId="nb1" user={{ id: 'u1' }} onBack={onBack} onListChanged={vi.fn()} onOpenProject={vi.fn()} />));
    return onBack;
};

beforeEach(() => { h.get.mockReset(); });
afterEach(cleanup);

describe('opening a notebook', () => {
    it('shows a skeleton at once, then the notebook', async () => {
        let answer: (v: unknown) => void = () => {};
        h.get.mockImplementation(() => new Promise((r) => { answer = r; }));
        renderDetail();
        expect(screen.getByTestId('notebook-skeleton')).toBeInTheDocument();
        answer({ notebook: { id: 'nb1', name: 'Research', role: 'owner' }, sources: [] });
        expect(await screen.findByTestId('view')).toHaveTextContent('Research');
    });

    it('a notebook that is gone or no longer shared says so, with a way back', async () => {
        const user = userEvent.setup();
        h.get.mockRejectedValue(httpError(404));
        const onBack = renderDetail();
        expect(await screen.findByText('This notebook is not available')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Back to notebooks' }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('a failure worth retrying offers a retry that works', async () => {
        const user = userEvent.setup();
        h.get.mockRejectedValueOnce(httpError(503)).mockResolvedValue({ notebook: { id: 'nb1', name: 'Research', role: 'owner' }, sources: [] });
        renderDetail();
        expect(await screen.findByText('The notebook could not be opened')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('view')).toBeInTheDocument();
    });
});

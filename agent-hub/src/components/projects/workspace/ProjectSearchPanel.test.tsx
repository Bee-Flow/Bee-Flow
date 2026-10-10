import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { testQueryClient, withQueryClient } from '../../../test/queryWrapper';
import ProjectSearchPanel from './ProjectSearchPanel';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));
vi.mock('../../../api/queries/projectDiscovery', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useProjectSearch: searchMock,
    useProjectPins: () => ({ data: { items: [] }, error: null }),
    useSetProjectPin: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

const found = {
    isPending: false, isError: false, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(),
    data: { pages: [{ items: [{ type: 'task', id: 't1', title: 'Write the launch email' }], nextCursor: null }] },
};

describe('ProjectSearchPanel', () => {
    it('searches after a pause, opens a result on its tab and closes', async () => {
        searchMock.mockReturnValue(found);
        const onOpenTab = vi.fn();
        const onClose = vi.fn();
        render(withQueryClient(<ProjectSearchPanel projectId="p1" role="editor" open onClose={onClose} onOpenTab={onOpenTab} />, testQueryClient()));
        await userEvent.type(screen.getByRole('searchbox'), 'launch');
        await userEvent.click(await screen.findByRole('button', { name: /Write the launch email/ }));
        expect(onOpenTab).toHaveBeenCalledWith('tasks', 't1');
        expect(onClose).toHaveBeenCalled();
        await vi.waitFor(() => expect(searchMock).toHaveBeenCalledWith('p1', 'launch', '', true));
    });

    it('renders nothing when closed', () => {
        searchMock.mockReturnValue(found);
        render(withQueryClient(<ProjectSearchPanel projectId="p1" role="viewer" open={false} onClose={vi.fn()} />));
        expect(screen.queryByRole('searchbox')).toBeNull();
    });
});

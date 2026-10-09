import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import { queryWrapper } from '../test/queryWrapper';
import DocumentPickerPopover from './DocumentPickerPopover';

vi.mock('../api/client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);

const DOCS = [
    { id: 'd1', name: 'Plan', docType: 'page', updatedAt: new Date().toISOString() },
    { id: 'd2', name: 'Budget', docType: 'sheet' },
];

function setup() {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
        <DocumentPickerPopover anchorRef={{ current: null }} open onClose={onClose} onSelect={onSelect} />,
        { wrapper: queryWrapper() },
    );
    return { onClose, onSelect };
}

beforeEach(() => { get.mockResolvedValue({ documents: DOCS }); post.mockResolvedValue({ document: { id: 'new1' } }); });
afterEach(() => { vi.clearAllMocks(); });

describe('DocumentPickerPopover', () => {
    it('lists documents, focuses the search and states the AI scope', async () => {
        setup();
        expect(await screen.findByText('Plan')).toBeTruthy();
        expect(screen.getByText('Budget')).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByRole('textbox'));
        expect(screen.getByText('The AI only reads the document you open here.')).toBeTruthy();
        expect(get).toHaveBeenCalledWith('/api/studio-documents', expect.objectContaining({
            query: { kind: 'document', sort: 'updated', limit: 50 },
        }));
    });

    it('searches with a query param', async () => {
        const user = userEvent.setup();
        setup();
        await screen.findByText('Plan');
        await user.type(screen.getByRole('textbox'), 'bud');
        await waitFor(() => expect(get).toHaveBeenLastCalledWith('/api/studio-documents', expect.objectContaining({
            query: { kind: 'document', sort: 'updated', limit: 50, query: 'bud' },
        })));
    });

    it('choosing a row selects it and closes', async () => {
        const user = userEvent.setup();
        const { onSelect, onClose } = setup();
        await user.click(await screen.findByText('Budget'));
        expect(onSelect).toHaveBeenCalledWith('d2');
        expect(onClose).toHaveBeenCalled();
    });

    it('New page creates a page and opens it', async () => {
        const user = userEvent.setup();
        const { onSelect } = setup();
        await screen.findByText('Plan');
        await user.click(screen.getByRole('button', { name: 'New page' }));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith('new1'));
        expect(post).toHaveBeenCalledWith('/api/studio-documents', { name: 'Untitled page', docType: 'page', kind: 'document' });
    });

    it('Escape closes', async () => {
        const user = userEvent.setup();
        const { onClose } = setup();
        await screen.findByText('Plan');
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalled();
    });
});

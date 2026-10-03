import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotebookSources from './NotebookSources';

vi.mock('../../components/meeting-picker/MeetingPicker', () => ({ default: () => null }));
vi.mock('../meeting-notes/capture/CaptureContext', () => ({ useCapture: () => ({ openCapture: () => {} }) }));

const SOURCES = [
    { id: 's1', type: 'pdf', name: 'Report.pdf', status: 'ready', wordCount: 1200, hasContent: true, metadata: {} },
    { id: 's3', type: 'url', name: 'Article', status: 'error', error: 'Could not reach the URL', hasContent: false, metadata: {} },
];

function props(over: Record<string, unknown> = {}) {
    return {
        sources: SOURCES,
        onFileUpload: vi.fn(), onAddUrl: vi.fn(), onAddText: vi.fn(), onAddMeeting: vi.fn(),
        onDeleteSource: vi.fn(), onRetrySource: vi.fn(), onCancelSource: vi.fn(),
        onRenameSource: vi.fn(), onReorderSources: vi.fn(), onBulkDelete: vi.fn(),
        onPreviewSource: vi.fn().mockResolvedValue({ name: 'Report.pdf', content: 'hello world' }),
        dragOver: false, setDragOver: vi.fn(), totalWords: 1200, readyCount: 1,
        ...over,
    };
}

afterEach(cleanup);

describe('NotebookSources: removing a source', () => {
    it('asks in place first, and only then removes', async () => {
        const user = userEvent.setup();
        const onDeleteSource = vi.fn();
        render(<NotebookSources {...props({ onDeleteSource })} />);
        await user.click(screen.getAllByRole('button', { name: 'Remove source' })[0]);
        expect(onDeleteSource).not.toHaveBeenCalled();
        const confirm = screen.getByTestId('source-confirm-delete');
        await user.click(screen.getByRole('button', { name: 'Keep' }));
        expect(confirm).not.toBeInTheDocument();
        expect(onDeleteSource).not.toHaveBeenCalled();

        await user.click(screen.getAllByRole('button', { name: 'Remove source' })[0]);
        await user.click(screen.getByRole('button', { name: 'Remove' }));
        expect(onDeleteSource).toHaveBeenCalledWith('s1');
    });

    it('offers Undo while a removal is pending', async () => {
        const user = userEvent.setup();
        const onUndoDelete = vi.fn();
        render(<NotebookSources {...props({ pendingDelete: { source: { id: 's9', name: 'Old memo' }, index: 0 }, onUndoDelete })} />);
        expect(screen.getByText('"Old memo" removed')).toBeInTheDocument();
        await user.click(screen.getByTestId('source-undo-button'));
        expect(onUndoDelete).toHaveBeenCalledTimes(1);
    });
});

describe('NotebookSources: the upload queue', () => {
    it('shows every file with what it is doing, and a failed one can be retried', async () => {
        const user = userEvent.setup();
        const onRetryUpload = vi.fn();
        const uploads = [
            { id: 'u1', name: 'a.pdf', size: 2048, status: 'done' },
            { id: 'u2', name: 'b.pdf', size: 4096, status: 'uploading' },
            { id: 'u3', name: 'c.docx', size: 1024, status: 'failed', error: 'This file is too large.' },
        ];
        render(<NotebookSources {...props({ uploads, onRetryUpload })} />);
        expect(screen.getByText('Uploading 1 of 3')).toBeInTheDocument();
        expect(screen.getByText('This file is too large.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Retry c.docx' }));
        expect(onRetryUpload).toHaveBeenCalledWith('u3');
    });
});

describe('NotebookSources: read-only for a viewer', () => {
    it('lists and previews, but offers no way to add, rename, reorder or remove', async () => {
        const user = userEvent.setup();
        const onPreviewSource = vi.fn().mockResolvedValue({ name: 'Report.pdf', content: 'extracted text' });
        render(<NotebookSources {...props({ readOnly: true, onPreviewSource })} />);
        expect(screen.getByText('Report.pdf')).toBeInTheDocument();
        for (const name of ['Remove source', 'Rename', 'Select multiple', 'Retry ingestion']) {
            expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
        }
        expect(screen.queryByRole('button', { name: /^Website$/ })).not.toBeInTheDocument();
        await user.dblClick(screen.getByText('Report.pdf'));
        expect(screen.queryByDisplayValue('Report.pdf')).not.toBeInTheDocument();
        expect(onPreviewSource).toHaveBeenCalledWith('s1');
    });

    it('says the notebook has no sources instead of inviting an upload', () => {
        render(<NotebookSources {...props({ readOnly: true, sources: [], readyCount: 0, totalWords: 0 })} />);
        expect(screen.getByTestId('sources-empty-readonly')).toBeInTheDocument();
        expect(screen.queryByText('Add your first source')).not.toBeInTheDocument();
    });
});

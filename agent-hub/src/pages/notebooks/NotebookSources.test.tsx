import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import NotebookSources from './NotebookSources';

// Stub the meeting picker + capture context (not under test here).
vi.mock('../../components/meeting-picker/MeetingPicker', () => ({ default: () => null }));
vi.mock('../meeting-notes/capture/CaptureContext', () => ({ useCapture: () => ({ openCapture: () => {} }) }));

const SOURCES = [
    { id: 's1', type: 'pdf', name: 'Report.pdf', status: 'ready', wordCount: 1200, hasContent: true, metadata: {} },
    { id: 's2', type: 'text', name: 'Notes', status: 'processing', stage: 'embedding', hasContent: true, metadata: {} },
    { id: 's3', type: 'url', name: 'Article', status: 'error', error: 'Could not reach the URL', hasContent: false, metadata: {} },
];

const baseProps = (over: Record<string, unknown> = {}) => ({
    sources: SOURCES,
    onFileUpload: vi.fn(), onAddUrl: vi.fn(), onAddText: vi.fn(), onAddMeeting: vi.fn(),
    onDeleteSource: vi.fn(), onRetrySource: vi.fn(), onCancelSource: vi.fn(),
    onRenameSource: vi.fn(), onReorderSources: vi.fn(), onBulkDelete: vi.fn(),
    onPreviewSource: vi.fn().mockResolvedValue({ name: 'Report.pdf', content: 'hello world' }),
    dragOver: false, setDragOver: vi.fn(), totalWords: 1200, readyCount: 1,
    ...over,
});

afterEach(cleanup);

describe('NotebookSources', () => {
    it('shows the ingestion stage while processing, the word count when ready and the server message on failure', () => {
        render(<NotebookSources {...baseProps()} />);
        expect(screen.getByText('Indexing…')).toBeTruthy(); // stage: embedding
        expect(within(screen.getAllByTestId('source-card')[0]).getByText('1,200 words')).toBeTruthy();
        expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the URL');
    });

    it('renames a source via the inline editor', async () => {
        const user = userEvent.setup();
        const onRenameSource = vi.fn();
        render(<NotebookSources {...baseProps({ onRenameSource })} />);
        await user.dblClick(screen.getByText('Report.pdf'));
        const input = screen.getByDisplayValue('Report.pdf');
        await user.clear(input);
        await user.type(input, 'Q4 Report{Enter}');
        expect(onRenameSource).toHaveBeenCalledWith('s1', 'Q4 Report');
    });

    it('opens a preview for a source with stored content', async () => {
        const user = userEvent.setup();
        const onPreviewSource = vi.fn().mockResolvedValue({ name: 'Report.pdf', content: 'extracted text body' });
        render(<NotebookSources {...baseProps({ onPreviewSource })} />);
        await user.click(screen.getByText('Report.pdf'));
        expect(onPreviewSource).toHaveBeenCalledWith('s1');
        expect(await screen.findByText('extracted text body')).toBeTruthy();
    });

    it('says so when the preview cannot be loaded', async () => {
        const user = userEvent.setup();
        render(<NotebookSources {...baseProps({ onPreviewSource: vi.fn().mockRejectedValue(new Error('boom')) })} />);
        await user.click(screen.getByText('Report.pdf'));
        expect(await screen.findByText(/preview could not be loaded/i)).toBeTruthy();
    });

    it('selects multiple and bulk-deletes after confirm', async () => {
        const user = userEvent.setup();
        const onBulkDelete = vi.fn();
        render(<NotebookSources {...baseProps({ onBulkDelete })} />);
        await user.click(screen.getByRole('button', { name: 'Select multiple' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Report.pdf' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Notes' }));
        expect(screen.getByText('2 selected')).toBeTruthy();
        // bulk-bar Delete opens the confirm dialog, then the dialog's own Delete confirms
        await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
        const deletes = screen.getAllByRole('button', { name: 'Delete' });
        await user.click(deletes[deletes.length - 1]);
        expect(onBulkDelete).toHaveBeenCalledWith(['s1', 's2']);
    });

    it('retries a failed source', async () => {
        const user = userEvent.setup();
        const onRetrySource = vi.fn();
        render(<NotebookSources {...baseProps({ onRetrySource })} />);
        await user.click(screen.getByTitle('Retry ingestion'));
        expect(onRetrySource).toHaveBeenCalledWith('s3');
    });

    it('keeps Remove visible on a failed source (no hover needed)', () => {
        render(<NotebookSources {...baseProps()} />);
        const failed = screen.getAllByTestId('source-card').find((c) => c.dataset.status === 'error')!;
        expect(within(failed).getByRole('button', { name: 'Remove source' }).parentElement).not.toHaveClass('opacity-0');
    });

    it('adds a website URL and closes the form', async () => {
        const user = userEvent.setup();
        const onAddUrl = vi.fn();
        render(<NotebookSources {...baseProps({ onAddUrl })} />);
        await user.click(screen.getByRole('button', { name: /^Website$/ }));
        await user.type(screen.getByRole('textbox', { name: 'Add URL' }), 'https://example.com/a{Enter}');
        expect(onAddUrl).toHaveBeenCalledWith('https://example.com/a');
        expect(screen.queryByRole('textbox', { name: 'Add URL' })).not.toBeInTheDocument();
    });

    it('adds pasted text with an optional name', async () => {
        const user = userEvent.setup();
        const onAddText = vi.fn();
        render(<NotebookSources {...baseProps({ onAddText })} />);
        await user.click(screen.getByRole('button', { name: /Paste text/ }));
        await user.type(screen.getByRole('textbox', { name: 'Name (optional)' }), 'Memo');
        await user.type(screen.getByRole('textbox', { name: 'Paste Text' }), 'Some words');
        await user.click(screen.getByRole('button', { name: 'Add Text' }));
        expect(onAddText).toHaveBeenCalledWith('Some words', 'Memo');
    });

    it('shows the shared empty state with an upload action when there are no sources', async () => {
        const user = userEvent.setup();
        const { container } = render(<NotebookSources {...baseProps({ sources: [], readyCount: 0, totalWords: 0 })} />);
        expect(screen.getByText('Add your first source')).toBeTruthy();
        const click = vi.spyOn(container.querySelector('input[type="file"]') as HTMLInputElement, 'click');
        const buttons = screen.getAllByRole('button', { name: /Upload file/ });
        await user.click(buttons[buttons.length - 1]);
        expect(click).toHaveBeenCalled();
    });
});

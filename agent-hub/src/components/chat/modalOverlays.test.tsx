import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DlpReviewShell from './dlpReview/DlpReviewShell';
import GoogleWorkspacePickerModal from './GoogleWorkspacePickerModal';
import ImageLightbox from './MessageItem/ImageLightbox';

vi.mock('../../hooks/useGoogleWorkspacePicker', () => ({
    default: () => ({
        status: { connected: true, configured: true, user: { email: 'me@example.test' } },
        items: [],
        loading: false,
        searchQuery: '',
        setSearchQuery: vi.fn(),
        selectedIds: new Set(),
        toggleItem: vi.fn(),
        exporting: false,
        error: null,
        nextPageToken: null,
        loadMore: vi.fn(),
        handleAttach: vi.fn(),
        handleConnect: vi.fn(),
    }),
}));

/**
 * The chat overlays, now that they are dialogs.
 *
 * Two of them must NOT gain the usual ways out: the DLP review is a decision
 * the server waits for, so Escape and the backdrop stay inert there. And the
 * Google picker must keep its search field focused on open, not the first
 * control (the close button): its autoFocus field keeps the focus it took.
 */
describe('chat overlays, once they are dialogs', () => {
    beforeEach(() => cleanup());

    const PENDING = {
        kind: 'chat_text',
        decisionId: 'd1',
        provider: { displayName: 'OpenAI', isExternal: true },
        reviewText: 'hello Alice',
        findings: [],
        summary: {},
    };

    it('the DLP review is a named dialog that neither Escape nor the backdrop dismisses', () => {
        const onSubmit = vi.fn();
        render(<DlpReviewShell pending={PENDING} onSubmit={onSubmit} submitting={false} error={null} />);
        const dialog = screen.getByRole('dialog', { name: 'Check this before it goes to the AI' });

        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.mouseDown(dialog.parentElement!);

        expect(screen.getByRole('dialog', { name: 'Check this before it goes to the AI' })).toBeInTheDocument();
        expect(onSubmit).not.toHaveBeenCalled();
        // …but the focus is in it now, instead of in the composer behind it.
        expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('the lightbox closes on Escape and on a press beside the picture, not on the picture', () => {
        const setLightboxImage = vi.fn();
        render(<ImageLightbox lightboxImage="https://example.test/cat.png" setLightboxImage={setLightboxImage} />);
        const dialog = screen.getByRole('dialog', { name: 'Generated image' });

        fireEvent.mouseDown(screen.getByRole('img', { name: 'Generated image' }));
        expect(setLightboxImage).not.toHaveBeenCalled();

        // The invisible panel around the picture counts as "beside it", as the
        // scrim did when the panel was shrink-wrapped.
        fireEvent.mouseDown(dialog.querySelector('.cursor-pointer')!);
        expect(setLightboxImage).toHaveBeenCalledWith(null);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(setLightboxImage).toHaveBeenCalledTimes(2);
    });

    it('the Google picker opens with the search field focused, not the close button', () => {
        // Its props are all required by inference from the JS signature; the
        // picker needs only these for the dialog shell.
        const Picker = GoogleWorkspacePickerModal as unknown as React.ComponentType<Record<string, unknown>>;
        const Icon = () => <svg aria-hidden="true" />;
        render(
            <Picker
                isOpen
                onClose={vi.fn()}
                onFilesSelected={vi.fn()}
                title="Google Drive"
                icon={Icon}
                emptyIcon={Icon}
                searchPlaceholder="Search Drive"
                renderItem={() => null}
            />,
        );
        expect(screen.getByRole('dialog', { name: 'Google Drive' })).toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByPlaceholderText('Search Drive'));
    });
});

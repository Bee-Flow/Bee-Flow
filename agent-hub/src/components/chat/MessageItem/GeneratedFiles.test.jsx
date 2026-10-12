import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeneratedFiles } from './GeneratedMedia';

/**
 * A deck a tool built shows up as a card under the reply — from the tool's
 * RESULT, so it is there even when the model forgot to write the link.
 */
beforeEach(() => cleanup());

describe('GeneratedFiles', () => {
    it('renders a Nextcloud deck with "Open in Nextcloud Office" and a local deck with Download', () => {
        render(<GeneratedFiles msg={{ files: [
            { kind: 'presentation', name: 'Q3.pptx', slideCount: 8, size: 204800, path: '/Presentations/Q3.pptx', webUrl: 'https://nc.example/f/482' },
            { kind: 'presentation', name: 'local.pptx', slideCount: 3, url: '/api/storage/file/users/u1/presentations/x_local.pptx' },
        ] }} />);
        const open = screen.getByText('Open in Nextcloud Office');
        expect(open.closest('a').getAttribute('href')).toBe('https://nc.example/f/482');
        expect(open.closest('a').getAttribute('target')).toBe('_blank');
        expect(screen.getByText('Q3.pptx')).toBeTruthy();
        expect(screen.getByText(/8 slides · 200 KB · \/Presentations\/Q3\.pptx/)).toBeTruthy();
        const dl = screen.getByText('Download');
        expect(dl.closest('a').getAttribute('href')).toMatch(/\/api\/storage\/file\/users\/u1\/presentations\/x_local\.pptx$/);
        expect(screen.queryAllByText('Open in Nextcloud Office')).toHaveLength(1);
    });

    it('a Word document from create_word_document gets its own icon and a Download link', () => {
        const { container } = render(<GeneratedFiles msg={{ files: [
            { kind: 'word', name: 'Offerte-Acme.docx', size: 12288, url: '/api/storage/file/users/u1/documents/x_Offerte-Acme.docx', source: 'create_word_document' },
        ] }} />);
        expect(screen.getByText('Offerte-Acme.docx')).toBeTruthy();
        expect(container.querySelector('[data-file-kind]').getAttribute('data-file-kind')).toBe('word');
        expect(screen.getByText('Download').closest('a').getAttribute('href')).toMatch(/\/documents\/x_Offerte-Acme\.docx$/);
    });

    it('a deck kept in the library gets an Open button that hands it to the chat shell, and falls back to the Studio page', () => {
        render(<GeneratedFiles msg={{ files: [
            { kind: 'presentation', name: 'Kick-off.pptx', slideCount: 5, url: '/api/storage/file/users/u1/presentations/k.pptx', documentId: 'doc-9', documentUrl: '/app/studio/documents/doc-9' },
        ] }} />);
        const open = screen.getByTestId('generated-file-open');
        expect(open.textContent).toBe('Open');
        // Claimed by the shell: no navigation.
        const claim = (e) => { e.preventDefault(); };
        window.addEventListener('beeflow:open-document-side', claim);
        const seen = [];
        const spy = (e) => seen.push(e.detail);
        window.addEventListener('beeflow:open-document-side', spy);
        const push = vi.spyOn(window.history, 'pushState');
        fireEvent.click(open);
        expect(seen).toEqual([{ id: 'doc-9', href: '/app/studio/documents/doc-9' }]);
        expect(push).not.toHaveBeenCalled();
        // Nobody claims it: the Studio page.
        window.removeEventListener('beeflow:open-document-side', claim);
        fireEvent.click(open);
        expect(push).toHaveBeenCalledWith({ page: 'studio' }, '', '/app/studio/documents/doc-9');
        window.removeEventListener('beeflow:open-document-side', spy);
        push.mockRestore();
        expect(screen.getByText('Download')).toBeTruthy();
    });
});

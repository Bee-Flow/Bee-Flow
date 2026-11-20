import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useNotebookExports, { exportErrorText, type ExportDeps } from './useNotebookExports';
import type { TranslateFn } from '@/hooks/useTranslation';

// A translator that marks what it translated, so the test can see which path ran.
const t = vi.fn((key: string, fallback?: unknown) => `[${key}] ${String(fallback ?? '')}`) as unknown as TranslateFn;

describe('exportErrorText', () => {
    it('translates the PDF-renderer 503 by its code, with the server sentence as fallback', () => {
        const text = exportErrorText(
            { error: 'PDF export is not available on this server.', code: 'pdf_renderer_unavailable' },
            t,
            'Export failed (503)',
        );
        expect(text).toBe('[notebooks.pdf_renderer_unavailable] PDF export is not available on this server.');
    });

    it('shows the server sentence for a code it does not translate', () => {
        expect(exportErrorText({ error: 'Notebook not found', code: 'not_found' }, t, 'Export failed (404)'))
            .toBe('Notebook not found');
    });

    it('falls back when the body has no error (a body that was not JSON)', () => {
        expect(exportErrorText({}, t, 'Export failed (500)')).toBe('Export failed (500)');
        expect(exportErrorText(null, t, 'Export failed (500)')).toBe('Export failed (500)');
    });

    it('translates the render timeout by its code', () => {
        expect(exportErrorText({ error: 'too slow', code: 'pdf_render_timeout' }, t, 'Export failed (504)'))
            .toBe('[notebooks.pdf_render_timeout] too slow');
    });

    it('appends the correlation id to a generic error so it can be traced in the log', () => {
        expect(exportErrorText({ error: 'Internal server error', correlationId: 'abc123' }, t, 'Export failed (500)'))
            .toBe('[notebooks.export_error_ref] {message} (ref: {ref})');
        expect(t).toHaveBeenLastCalledWith('notebooks.export_error_ref', '{message} (ref: {ref})',
            { message: 'Internal server error', ref: 'abc123' });
    });
});

describe('useNotebookExports: diagrams in every export', () => {
    const diagram = `<p>Intro</p><div data-type="mermaid-diagram" data-code="${btoa('graph TD; A-->B')}"></div>`;
    const apiFetch = vi.fn();
    // Fakes through the hook's seam: no network, no Mermaid, images left as they are.
    const deps: Partial<ExportDeps> = {
        apiFetch: apiFetch as unknown as ExportDeps['apiFetch'],
        embedImagesAsBase64: async (html: string) => html,
        renderMermaidToSVG: async (code: string) => `<svg>${code}</svg>`,
        svgToPngDataUrl: async () => 'data:image/png;base64,AAAA',
    };
    const sentContent = () => JSON.parse(apiFetch.mock.lastCall?.[1].init.body).content as string;
    const setup = () => renderHook(() => useNotebookExports({ notebookId: 'nb1', title: 'Plan', getContent: () => diagram, onNotice: vi.fn(), deps })).result;

    it('renders a diagram to an image before sending for signing', async () => {
        apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        const result = setup();
        await act(async () => { await result.current.handleSendForSigning({ signers: [] }); });
        expect(apiFetch.mock.lastCall?.[0]).toBe('POST /api/notebooks/{id}/export/signrequest');
        expect(sentContent()).toContain('<img src="data:image/png;base64,AAAA"');
        expect(sentContent()).not.toContain('mermaid-diagram');
    });

    it('renders a diagram to an image before saving to Nextcloud', async () => {
        apiFetch.mockResolvedValue(new Response(JSON.stringify({ path: '/Plan.pdf' }), { status: 200 }));
        const result = setup();
        await act(async () => { await result.current.handleNextcloudExport(); });
        expect(apiFetch.mock.lastCall?.[0]).toBe('POST /api/notebooks/{id}/export/nextcloud');
        expect(sentContent()).toContain('<img src="data:image/png;base64,AAAA"');
        expect(sentContent()).not.toContain('mermaid-diagram');
    });
});

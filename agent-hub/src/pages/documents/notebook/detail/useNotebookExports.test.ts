import { describe, expect, it, vi } from 'vitest';
import { exportErrorText } from './useNotebookExports';
import type { TranslateFn } from '../../../../hooks/useTranslation';

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
});

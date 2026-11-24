import { describe, expect, it } from 'vitest';
import { docPill, failureDetail, failureText, takenFrom } from './docText';
import type { TranslateFn } from '@/hooks/useTranslation';

// The English fallback with its placeholders filled: what a fresh install shows.
const t = ((_key: string, fallback: string, params: Record<string, unknown> = {}) =>
    String(fallback).replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k] ?? ''))) as unknown as TranslateFn;

describe('docText', () => {
    it('counts one file in the singular and more in the plural', () => {
        expect(docPill(t, { documentCount: 1, processedCount: 0 })).toBe('1 file · 0 processed');
        expect(docPill(t, { documentCount: 38, processedCount: 30, redactedCount: 6 })).toBe('38 files · 36 processed');
    });

    it('says a failure in plain words and keeps the raw error for the tooltip', () => {
        const doc = { id: 'd', title: 'Text snippet', status: 'error', status_reason: 'Local ingestion failed: Document produced no chunks' };
        expect(takenFrom(t, doc)).toBe('Too little text to search. Add a longer text instead.');
        expect(failureDetail(doc)).toBe('Local ingestion failed: Document produced no chunks');
        expect(failureText(t, 'Embedding timed out')).toBe('This could not be added. Try again, or remove it.');
    });

    it('shows the summary when there is one, and a skip reason as it is', () => {
        expect(takenFrom(t, { id: 'd', title: 'x', status: 'processed', extract_summary: 'Prices for 2026' })).toBe('Prices for 2026');
        expect(takenFrom(t, { id: 'd', title: 'x', status: 'skipped', status_reason: 'Queued for processing' })).toBe('Queued for processing');
        expect(failureDetail({ id: 'd', title: 'x', status: 'skipped', status_reason: 'Queued' })).toBeUndefined();
    });
});

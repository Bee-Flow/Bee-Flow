import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import DlpDocumentRenderer from './DlpDocumentRenderer';

const SHEET = '| Naam | Bedrag |\n| --- | --- |\n| Jan Jansen | 100 |\n| Piet Puk | 250 |\n';

describe('DlpDocumentRenderer', () => {
    beforeEach(cleanup);

    it('renders spreadsheet-shaped content as a real <table>, not raw pipe text', () => {
        render(<DlpDocumentRenderer filename="cijfers.xlsx" text={SHEET} spans={[]} onAddSpan={() => {}} onRemoveSpan={() => {}} />);
        expect(document.querySelector('table')).toBeTruthy();
        expect(screen.getByText('Jan Jansen')).toBeTruthy();
        expect(screen.getByText('Naam')).toBeTruthy();
        // The divider row must never render as a data row.
        expect(screen.queryByText('---')).toBeNull();
    });

    it('highlights a finding inside its own cell, at the exact reported offset', () => {
        const idx = SHEET.indexOf('Jan Jansen');
        const spans = [{ id: 'pii_0', category: 'Person', source: 'pii', offset: idx, length: 'Jan Jansen'.length, text: 'Jan Jansen', confidenceBand: 'high' }];
        render(<DlpDocumentRenderer filename="cijfers.xlsx" text={SHEET} spans={spans} onAddSpan={() => {}} onRemoveSpan={() => {}} />);
        const mark = document.querySelector('mark');
        expect(mark).toBeTruthy();
        expect(mark.textContent).toBe('Jan Jansen');
    });

    it('falls back to flowed text (no table) for non-tabular content like a PDF', () => {
        render(<DlpDocumentRenderer filename="brief.pdf" text={'Beste heer,\n\nDit is een gewone brief.'} spans={[]} onAddSpan={() => {}} onRemoveSpan={() => {}} />);
        expect(document.querySelector('table')).toBeNull();
        expect(screen.getByText(/Dit is een gewone brief/)).toBeTruthy();
    });
});

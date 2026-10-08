import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import CitationChips, { chipLabel } from './CitationChips';

/**
 * The chip row, shared by notebook chat, agent chat and the Knowledge
 * Studio's test question.
 *
 * "Personeelshandboek" is not a citation — it names a document and stops.
 * "Personeelshandboek · p. 12" is one: it can be checked. But `page` only
 * exists for documents ingested after the chunker learned to stamp it, and the
 * bytes of everything before that are gone. So a chip WITHOUT a page is the
 * permanent normal state for a large part of any install, and it has to render
 * as a chip that says less — never as a gap, a "p. ?" or nothing at all.
 */

const src = (over = {}) => ({
    title: 'Personeelshandboek', kind: 'kb_chunk', documentId: 'doc-1', chunkId: 3,
    page: 12, section: 'Verlof', content: 'Twee dagen vrij.', score: 0.9, ...over,
});

const t = (k, fb, p) => (p ? String(fb).replace(/\{(\w+)\}/g, (_, n) => p[n]) : fb);

describe('CitationChips', () => {
    it('names the document and the page', () => {
        render(<CitationChips sources={[src()]} t={t} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek · p. 12');
    });

    it('renders a chip with no page rather than no chip', () => {
        render(<CitationChips sources={[src({ page: null })]} t={t} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek');
    });

    it('never prints a page nobody counts from', () => {
        // `p. 0` and `p. -1` say the chunker guessed, which is worse than
        // saying nothing.
        for (const page of [0, -1, 1.5, '12', null, undefined, NaN]) {
            expect(chipLabel(src({ page }), 0, t)).toBe('Personeelshandboek');
        }
    });

    it('falls back to a position when a passage has no title at all', () => {
        render(<CitationChips sources={[src({ title: null, page: null })]} t={t} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Source 1');
    });

    it('opens the passage, with its position, when clicked', () => {
        const onCitationClick = vi.fn();
        render(<CitationChips sources={[src()]} t={t} onCitationClick={onCitationClick} />);
        fireEvent.click(screen.getByTestId('citation-chip'));
        expect(onCitationClick).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 3, index: 1 }));
    });

    it('carries the section in the tooltip, where it does not crowd the label', () => {
        render(<CitationChips sources={[src()]} t={t} />);
        expect(screen.getByTestId('citation-chip').getAttribute('title')).toBe('Personeelshandboek · p. 12 — Verlof');
    });

    it('tells one kind of source from another at a glance', () => {
        // All-documents-are-a-page-glyph makes a meeting note and a web page
        // look like the same thing.
        render(<CitationChips sources={[src({ kind: 'webpage' }), src({ kind: 'meeting' })]} t={t} />);
        const [a, b] = screen.getAllByTestId('citation-chip');
        expect(a.querySelector('svg').getAttribute('class'))
            .not.toBe(b.querySelector('svg').getAttribute('class'));
    });

    it('renders nothing at all when there is nothing to cite', () => {
        const { container } = render(<CitationChips sources={[]} t={t} />);
        expect(container.firstChild).toBeNull();
        const empty = render(<CitationChips sources={null} t={t} />);
        expect(empty.container.firstChild).toBeNull();
    });

    it('works without a translator, and still fills the placeholder', () => {
        // The fallback used to return the raw string, so a surface that does
        // not thread `t` through rendered the literal `p. {n}` — a placeholder
        // shown to a person reads as a broken product, not a missing
        // translation.
        render(<CitationChips sources={[src()]} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek · p. 12');
    });
});

describe('CitationChips — rows and dates', () => {
    /** The same call the chip makes, so the assertion pins the shape, not the locale. */
    const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    it('a table passage cites the rows it covers', () => {
        // A page number answers "which part of this" for a PDF and for nothing
        // else. A block of table rows had no way to say where it was at all.
        render(<CitationChips sources={[src({ title: 'Producten', page: null, rowStart: 1, rowEnd: 50 })]} t={t} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Producten · rows 1–50');
    });

    it('a single row is a range of one, not "rows 7–7"', () => {
        expect(chipLabel(src({ title: 'Producten', page: null, rowStart: 7, rowEnd: 7 }), 0, t))
            .toBe('Producten · row 7');
    });

    it('half a range is left out, because "rows 12–" reads as a bug', () => {
        for (const over of [{ rowStart: 12 }, { rowEnd: 12 }, { rowStart: 50, rowEnd: 1 }, { rowStart: 0, rowEnd: 0 }]) {
            expect(chipLabel(src({ title: 'Producten', page: null, ...over }), 0, t)).toBe('Producten');
        }
    });

    it('the rows win over a page, when a passage somehow carries both', () => {
        // The rows are the thing a person can go and check in a table.
        expect(chipLabel(src({ title: 'Producten', page: 3, rowStart: 1, rowEnd: 50 }), 0, t))
            .toBe('Producten · rows 1–50');
    });

    it('a meeting cites the day it was HELD', () => {
        const occurredAt = '2026-07-22T09:00:00.000Z';
        render(<CitationChips sources={[src({ title: 'Salesoverleg', kind: 'meeting', page: null, occurredAt })]} t={t} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe(`Salesoverleg · ${day(occurredAt)}`);
    });

    it('a date it cannot read is left out, never printed as "Invalid Date"', () => {
        for (const occurredAt of ['', '   ', 'last spring', 20260722, null, undefined]) {
            expect(chipLabel(src({ title: 'Salesoverleg', page: null, occurredAt }), 0, t)).toBe('Salesoverleg');
        }
    });

    it('a page and a date sit side by side without crowding each other out', () => {
        const occurredAt = '2026-07-22T09:00:00.000Z';
        expect(chipLabel(src({ occurredAt }), 0, t))
            .toBe(`Personeelshandboek · p. 12 · ${day(occurredAt)}`);
    });

    it('a LIVE table row cites the table it was read from', () => {
        // Een rij die op het moment van de vraag uit de tabel kwam heeft geen
        // pagina, geen rijbereik en geen datum. Zonder de tabelnaam is "Widget
        // A" precies de kale chip waar het paginanummer voor bestaat.
        const row = src({
            title: 'Widget A', kind: 'datatable_row', page: null, section: 'Producten',
            datatableId: 't-1', rowId: 'r-7', sourceName: 'Producten',
        });
        render(<CitationChips sources={[row]} t={t} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Widget A · Producten');
    });

    it('BIJT — een halve rijverwijzing plakt geen tabelnaam op een gewone passage', () => {
        // `datatableId` en `rowId` zijn een paar (core/kb/citation.js zet ze
        // samen of geen van beide). Op `sourceName` alleen afgaan zou
        // "Nextcloud · /Sales" achter elke kb-chip in het product zetten.
        for (const over of [{ datatableId: 't-1' }, { rowId: 'r-7' }, {}]) {
            expect(chipLabel(src({ page: null, sourceName: 'Nextcloud · /Sales', ...over }), 0, t))
                .toBe('Personeelshandboek');
        }
    });

    it('een tabelrij draagt de tabelglyph, niet die van een document', () => {
        // Op "anders dan een document" alleen testen is te zwak: een rij die
        // terugvalt op de generieke bestandsglyph is ook "anders", en dan is
        // een rij weer een pagina van een pdf.
        const row = src({ title: 'Widget A', kind: 'datatable_row', page: null, datatableId: 't-1', rowId: 'r-7', sourceName: 'Producten' });
        const { container } = render(<CitationChips sources={[src(), row]} t={t} />);
        const [doc, table] = [...container.querySelectorAll('[data-testid="citation-chip"] svg')];
        expect(table.getAttribute('class')).toContain('lucide-table');
        expect(doc.getAttribute('class')).not.toContain('lucide-table');
    });

    it('noemt de tabel niet twee keer in de tooltip', () => {
        // De "kop" van een rij is de naam van de tabel, en die staat al in het
        // label: "Widget A · Producten — Producten" leest als een fout.
        const row = src({ title: 'Widget A', kind: 'datatable_row', page: null, section: 'Producten', datatableId: 't-1', rowId: 'r-7', sourceName: 'Producten' });
        render(<CitationChips sources={[row]} t={t} />);
        expect(screen.getByTestId('citation-chip').getAttribute('title')).toBe('Widget A · Producten');
    });

    it('REGRESSION: a citation from before any of this renders exactly as it did', () => {
        // Every citation already sitting in every stored conversation.
        expect(chipLabel(src(), 0, t)).toBe('Personeelshandboek · p. 12');
        expect(chipLabel(src({ page: null }), 0, t)).toBe('Personeelshandboek');
        render(<CitationChips sources={[src()]} t={t} />);
        expect(screen.getByTestId('citation-chip').getAttribute('title')).toBe('Personeelshandboek · p. 12 — Verlof');
    });
});

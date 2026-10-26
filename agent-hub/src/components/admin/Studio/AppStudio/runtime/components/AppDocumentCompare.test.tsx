import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppDocumentCompare from './AppDocumentCompare';
import { mountInApp, stubFetch } from './documentCompare/documentTestKit';

/**
 * document_compare: what changed between two Studio documents, drawn per
 * family from the server's structured answer — decks slide by slide with both
 * rendered, text block by block, sheets cell by cell — plus version mode (only
 * `left` bound: the document now against an earlier version the viewer picks).
 */

const node = (left: unknown, right: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'cmp_dc', type: 'document_compare',
    props: { left: { kind: 'static', value: left }, right: { kind: 'static', value: right }, leftLabel: 'Original', rightLabel: 'New template', ...extra },
    style: { span: 12, height: 'xl' },
});
const meta = (id: string, versionId: string | null = `v-${id}`, family = 'deck') => ({ id, name: `Doc ${id}`, docType: family === 'deck' ? 'presentation' : (family === 'sheet' ? 'spreadsheet' : 'page'), family, versionId, updatedAt: null });

const DECK = {
    left: meta('d1'), right: meta('c1'),
    leftHtml: '<html>left deck</html>', rightHtml: '<html>right deck</html>',
    result: {
        family: 'deck',
        look: [{ key: 'preset', before: 'band', after: 'minimal' }],
        summary: { changed: 1, added: 1, removed: 0, unchanged: 1, lookChanged: true, wordsAdded: 3, wordsRemoved: 1 },
        slides: [
            { op: 'equal', left: { index: 0, title: 'Quarterly review', layout: 'cover' }, right: { index: 0, title: 'Quarterly review', layout: 'cover' }, layoutChanged: false, lines: [], wordsAdded: 0, wordsRemoved: 0 },
            { op: 'changed', left: { index: 1, title: 'Results', layout: 'bullets' }, right: { index: 1, title: 'Results', layout: 'bullets' }, layoutChanged: false, wordsAdded: 1, wordsRemoved: 1,
                lines: [{ op: 'modify', before: '• Revenue grew 10%', after: '• Revenue grew 12%', words: [{ op: 'equal', text: '• Revenue grew ' }, { op: 'delete', text: '10' }, { op: 'insert', text: '12' }, { op: 'equal', text: '%' }] }] },
            { op: 'added', left: null, right: { index: 2, title: 'Timeline', layout: 'bullets' }, layoutChanged: false, wordsAdded: 2, wordsRemoved: 0,
                lines: [{ op: 'insert', after: '# Timeline' }, { op: 'insert', after: '• Q1 kick-off' }] },
        ],
    },
};

let calls: ReturnType<typeof stubFetch>;
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() as never; });
afterEach(() => { vi.unstubAllGlobals(); });

const posted = () => calls.filter((c) => c.url.includes('/documents/compare')).map((c) => JSON.parse(String(c.init?.body)));

describe('AppDocumentCompare — two presentations', () => {
    beforeEach(() => { calls = stubFetch([['/documents/compare', () => ({ body: DECK })]]); });

    it('asks the server for this component\'s compare and sums it up', async () => {
        mountInApp(<AppDocumentCompare node={node('d1', { kind: 'studio_document', documentId: 'c1' }) as never} />);
        expect(await screen.findByText('1 slide changed, 1 slide added, look changed')).toBeTruthy();
        expect(posted()).toEqual([{ node: 'cmp_dc', left: { documentId: 'd1', versionId: null }, right: { documentId: 'c1', versionId: null } }]);
    });

    it('lists the changed slides, renders both decks side by side and shows the slide\'s words', async () => {
        const { container } = mountInApp(<AppDocumentCompare node={node('d1', 'c1') as never} />);
        await screen.findByText('Results');
        // Only changes by default: the unchanged cover is not in the strip.
        expect([...container.querySelectorAll('[data-slide-op]')].map((b) => b.getAttribute('data-slide-op'))).toEqual(['changed', 'added']);
        const frames = container.querySelectorAll('iframe');
        expect([...frames].map((f) => f.getAttribute('srcdoc'))).toEqual(['<html>left deck</html>', '<html>right deck</html>']);
        expect(container.querySelector('[data-slide-text] del')?.textContent).toBe('10');
        expect(screen.getByText(/Design/)).toBeTruthy();
    });

    it('steps to the next change, and an added slide says it is not in the original', async () => {
        mountInApp(<AppDocumentCompare node={node('d1', 'c1') as never} />);
        await screen.findByText('Results');
        await userEvent.click(screen.getByRole('button', { name: 'Next change' }));
        expect(screen.getByText('Not in Original')).toBeTruthy();
        expect(screen.getByRole('button', { current: true }).textContent).toContain('Timeline');
    });

    it('shows every slide when "Only changes" is off', async () => {
        const { container } = mountInApp(<AppDocumentCompare node={node('d1', 'c1') as never} />);
        await screen.findByText('Results');
        await userEvent.click(screen.getByRole('button', { name: 'Only changes' }));
        expect(container.querySelectorAll('[data-slide-op]')).toHaveLength(3);
    });
});

describe('AppDocumentCompare — text and sheets', () => {
    it('draws a text compare with the version-history renderer, side by side or inline', async () => {
        calls = stubFetch([['/documents/compare', () => ({ body: {
            left: meta('p1', 'v1', 'text'), right: meta('p2', 'v2', 'text'),
            result: { family: 'text', truncated: false, summary: { changed: 1, added: 0, removed: 0, unchanged: 1, wordsAdded: 1, wordsRemoved: 1 },
                blocks: [
                    { op: 'equal', before: { type: 'paragraph', content: [{ type: 'text', text: 'Intro stays.' }] }, after: { type: 'paragraph', content: [{ type: 'text', text: 'Intro stays.' }] } },
                    { op: 'modify', before: { type: 'paragraph', content: [{ type: 'text', text: 'Price is ten.' }] }, after: { type: 'paragraph', content: [{ type: 'text', text: 'Price is twelve.' }] },
                        words: [{ op: 'equal', text: 'Price is ' }, { op: 'delete', text: 'ten' }, { op: 'insert', text: 'twelve' }, { op: 'equal', text: '.' }] },
                ] },
        } })]]);
        const { container } = mountInApp(<AppDocumentCompare node={node('p1', 'p2', { onlyChanges: false }) as never} />);
        expect(await screen.findByText('1 paragraph changed')).toBeTruthy();
        expect(screen.getByTestId('compare-side')).toBeTruthy();
        expect(screen.getAllByText('Intro stays.')).toHaveLength(2);
        await userEvent.click(screen.getByRole('button', { name: 'Inline' }));
        expect(screen.getByTestId('compare-inline')).toBeTruthy();
        expect(container.querySelector('ins')?.textContent).toBe('twelve');
    });

    it('marks a changed cell, an added row and keeps the formula in the tooltip', async () => {
        calls = stubFetch([['/documents/compare', () => ({ body: {
            left: meta('s1', null, 'sheet'), right: meta('s2', null, 'sheet'),
            result: { family: 'sheet', summary: { tabsChanged: 1, tabsAdded: 0, tabsRemoved: 0, cellsChanged: 1, rowsAdded: 1, rowsRemoved: 0, columnsAdded: 0, columnsRemoved: 0 },
                tabs: [{ name: 'Parts', leftName: 'Parts', rightName: 'Parts', op: 'changed', hiddenRows: 0,
                    stats: { cellsChanged: 1, rowsAdded: 1, rowsRemoved: 0, columnsAdded: 0, columnsRemoved: 0 },
                    columns: [{ left: 'A', right: 'A', header: 'Name', op: 'equal' }, { left: 'B', right: 'B', header: 'Qty', op: 'equal' }],
                    rows: [
                        { op: 'added', left: null, right: 3, before: ['', ''], after: ['Washer', '2'], cells: [] },
                        { op: 'changed', left: 3, right: 4, before: ['Nut', '8'], after: ['Nut', '9'], cells: [{ col: 1, op: 'changed', before: '8', after: '9', beforeFormula: '=4*2', afterFormula: '=4*2+1' }] },
                    ] }] },
        } })]]);
        const { container } = mountInApp(<AppDocumentCompare node={node('s1', 's2', { mode: 'inline' }) as never} />);
        expect(await screen.findByText('1 cell changed, 1 row added')).toBeTruthy();
        const changed = container.querySelector('tr[data-sheet-row="changed"]') as HTMLElement;
        expect(within(changed).getByText('8').tagName).toBe('DEL');
        expect(within(changed).getByText('9').tagName).toBe('INS');
        expect(changed.querySelector('[title^="Formula"]')?.getAttribute('title')).toBe('Formula: =4*2 → =4*2+1');
        expect(screen.getByText('Washer')).toBeTruthy();
    });

    it('says why a spreadsheet and a page cannot be compared', async () => {
        calls = stubFetch([['/documents/compare', () => ({ status: 422, body: { error: 'x', code: 'documents_not_comparable' } })]]);
        mountInApp(<AppDocumentCompare node={node('s1', 'p1') as never} />);
        expect(await screen.findByText('A spreadsheet can only be compared with another spreadsheet.')).toBeTruthy();
    });
});

describe('AppDocumentCompare — two versions of one document', () => {
    const VERSIONS = { supported: true, versions: [
        { versionId: 'v3', label: null, source: 'autosave', createdAt: '2026-10-03T10:00:00Z', current: true },
        { versionId: 'v2', label: 'Sent to the board', source: 'named', createdAt: '2026-10-02T10:00:00Z', current: false },
        { versionId: 'v1', label: 'First draft', source: 'named', createdAt: '2026-10-01T10:00:00Z', current: false },
    ] };
    const TEXT = { left: meta('p1', 'v2', 'text'), right: meta('p1', 'v3', 'text'), result: { family: 'text', truncated: false, summary: { changed: 0, added: 0, removed: 0, unchanged: 1, wordsAdded: 0, wordsRemoved: 0 }, blocks: [] } };

    it('compares the current state with the newest earlier version, and with the one the viewer picks', async () => {
        calls = stubFetch([['/documents/p1/versions', () => ({ body: VERSIONS })], ['/documents/compare', () => ({ body: TEXT })]]);
        mountInApp(<AppDocumentCompare node={node('p1', null) as never} />);
        await waitFor(() => expect(posted()).toHaveLength(1));
        expect(posted()[0]).toEqual({ node: 'cmp_dc', left: { documentId: 'p1', versionId: 'v2' }, right: { documentId: 'p1', versionId: null } });
        await userEvent.selectOptions(await screen.findByRole('combobox'), 'v1');
        await waitFor(() => expect(posted()).toHaveLength(2));
        expect(posted()[1].left).toEqual({ documentId: 'p1', versionId: 'v1' });
        expect(screen.getByRole('option', { name: 'Sent to the board' })).toBeTruthy();
    });

    it('says so when there is no earlier version yet, and asks for no compare', async () => {
        calls = stubFetch([['/documents/p1/versions', () => ({ body: { supported: true, versions: [VERSIONS.versions[0]] } })]]);
        mountInApp(<AppDocumentCompare node={node('p1', 'p1') as never} />);
        expect(await screen.findByText('This document has no earlier version yet.')).toBeTruthy();
        expect(posted()).toEqual([]);
    });

    it('fetches nothing while designing', () => {
        calls = stubFetch([]);
        mountInApp(<AppDocumentCompare node={node('d1', 'c1') as never} />, { mode: 'design' });
        expect(screen.getByText('Original / New template')).toBeTruthy();
        expect(calls).toEqual([]);
    });
});

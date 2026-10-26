import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppDocumentViewer from './AppDocumentViewer';
import { mountInApp, stubFetch } from './documentCompare/documentTestKit';

/**
 * document_viewer: one Studio document, read-only. Text and decks arrive as
 * preview HTML and go into a sandboxed srcDoc frame (scripts, no origin);
 * spreadsheets as values on a grid. Nothing is fetched while designing, and a
 * refusal reads as a sentence.
 */

const node = (source: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'cmp_dv', type: 'document_viewer',
    props: { source: { kind: 'static', value: source }, emptyText: 'Pick a document first', ...extra },
    style: { span: 12, height: 'lg' },
});
const meta = (extra = {}) => ({ id: 'doc1', name: 'Quarterly review', docType: 'presentation', family: 'deck', versionId: 'v1', updatedAt: null, ...extra });

afterEach(() => { vi.unstubAllGlobals(); });

describe('AppDocumentViewer', () => {
    it('shows the empty text when nothing is bound, and fetches nothing', () => {
        const calls = stubFetch([]);
        mountInApp(<AppDocumentViewer node={node(null) as never} />);
        expect(screen.getByText('Pick a document first')).toBeTruthy();
        expect(calls).toEqual([]);
    });

    it('fetches nothing while the app is being designed', () => {
        const calls = stubFetch([]);
        mountInApp(<AppDocumentViewer node={node('doc1') as never} />, { mode: 'design' });
        expect(screen.getByText('The document shows here when the app runs.')).toBeTruthy();
        expect(calls).toEqual([]);
    });

    it('shows a deck or page in a sandboxed frame, asked for through this component', async () => {
        const calls = stubFetch([['/documents/doc1', () => ({ body: { document: meta(), html: '<html><body>slides</body></html>' } })]]);
        const { container } = mountInApp(<AppDocumentViewer node={node('doc1') as never} />);
        await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
        const frame = container.querySelector('iframe') as HTMLIFrameElement;
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('srcdoc')).toBe('<html><body>slides</body></html>');
        expect(screen.getByText('Quarterly review')).toBeTruthy();
        expect(calls[0].url).toContain('/api/studio-apps/app_1/documents/doc1?node=cmp_dv');
    });

    it('asks for an earlier version and says it is one', async () => {
        const calls = stubFetch([['/documents/doc1', () => ({ body: { document: meta({ docType: 'page', family: 'text', versionId: 'v0' }), html: '<p>old</p>' } })]]);
        mountInApp(<AppDocumentViewer node={node('doc1@v0') as never} />);
        expect(await screen.findByText('Earlier version')).toBeTruthy();
        expect(calls[0].url).toContain('version=v0');
    });

    it('shows a spreadsheet as its values, one tab at a time', async () => {
        stubFetch([['/documents/sheet1', () => ({ body: {
            document: meta({ id: 'sheet1', name: 'Budget', docType: 'spreadsheet', family: 'sheet' }),
            sheet: { tabs: [{ name: 'Costs', display: { A1: 'Item', B1: 'Amount', A2: 'Rent', B2: '1200' } }, { name: 'Income', display: { A1: 'Sales' } }] },
        } })]]);
        mountInApp(<AppDocumentViewer node={node('sheet1') as never} />);
        expect(await screen.findByText('1200')).toBeTruthy();
        expect(screen.getByRole('table', { name: 'Costs' })).toBeTruthy();
        await userEvent.click(screen.getByRole('tab', { name: 'Income' }));
        expect(screen.getByText('Sales')).toBeTruthy();
        expect(screen.queryByText('1200')).toBeNull();
    });

    it('says plainly when the app may not show the document, and offers to try again', async () => {
        stubFetch([['/documents/doc1', () => ({ status: 404, body: { error: 'This document is not available in this app.', code: 'document_not_found' } })]]);
        mountInApp(<AppDocumentViewer node={node('doc1') as never} />);
        expect(await screen.findByText('This document is not available in this app.')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
    });
});

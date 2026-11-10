import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';
import AppDocumentCompare from './AppDocumentCompare';
import AppDocumentViewer from './AppDocumentViewer';
import AppPdfCompare from './AppPdfCompare';
import CompareToolbar from './documentCompare/CompareToolbar';
import { mountInApp, stubFetch } from './documentCompare/documentTestKit';
import PdfCompareToolbar from './pdfCompare/Toolbar';
import { expectPartsMatch } from './recordPartClassKit';

/**
 * LK7b, record family (the document types): every part a type declares renders, and
 * no undeclared `bfa-` class does. The two toolbars are mounted on their own: their
 * parent only shows them once pdf.js or the compare answer has loaded.
 */

afterEach(() => { vi.unstubAllGlobals(); });

const node = (type: string, props: Record<string, unknown>) => ({ id: `cmp_${type}`, type, props, style: { span: 12, height: 'lg' } });
const stat = (value: unknown) => ({ kind: 'static', value });
const meta = (extra = {}) => ({ id: 'doc1', name: 'Quarterly review', docType: 'presentation', family: 'deck', versionId: 'v1', updatedAt: null, ...extra });
const noop = () => undefined;

describe('part classes: document types', () => {
    it('document_viewer (header, frame body, sheet tabs, version badge and the message states)', async () => {
        stubFetch([
            ['/documents/doc1', () => ({ body: { document: meta(), html: '<p>slides</p>' } })],
            ['/documents/sheet1', () => ({ body: {
                document: meta({ id: 'sheet1', name: 'Budget', docType: 'spreadsheet', family: 'sheet' }),
                sheet: { tabs: [{ name: 'Costs', display: { A1: 'Item' } }, { name: 'Income', display: { A1: 'Sales' } }] },
            } })],
        ]);
        const deck = mountInApp(<AppDocumentViewer node={node('document_viewer', { source: stat('doc1@v0') }) as never} />).container;
        await screen.findByText('Earlier version');
        const sheet = mountInApp(<AppDocumentViewer node={node('document_viewer', { source: stat('sheet1') }) as never} />).container;
        await screen.findByRole('tab', { name: 'Income' });
        const design = mountInApp(<AppDocumentViewer node={node('document_viewer', { source: stat('doc1') }) as never} />, { mode: 'design' }).container;
        await waitFor(() => screen.getAllByText('The document shows here when the app runs.'));
        expectPartsMatch('document_viewer', [deck, sheet, design]);
    });

    it('document_compare (root and message in the app, the toolbar on its own)', () => {
        stubFetch([]);
        const design = mountInApp(<AppDocumentCompare node={node('document_compare', { left: stat('doc1'), right: stat('doc2') }) as never} />, { mode: 'design' }).container;
        const toolbar = render(
            <CompareToolbar mode="side" onMode={noop} onlyChanges onOnlyChanges={noop} onStep={noop} summary="1 change" changed versions={null} />,
        ).container;
        expectPartsMatch('document_compare', [design, toolbar]);
    });

    it('pdf_compare (root and message in the app, the toolbar on its own)', () => {
        stubFetch([]);
        const design = mountInApp(<AppPdfCompare node={node('pdf_compare', { left: stat({ kind: 'studio_attachment', fileId: 'f1', name: 'a.pdf', mime: 'application/pdf' }) }) as never} />, { mode: 'design' }).container;
        const toolbar = render(
            <PdfCompareToolbar
                page={1} numPages={2} onPage={noop} zoom={1} onZoom={noop} mode="side" onMode={noop} comparable
                showChanges onShowChanges={noop} thumbs={false} onThumbs={noop} anyChanges onChange={noop}
                changesText="1 change" changeCount={1} downloads={null}
            />,
        ).container;
        expectPartsMatch('pdf_compare', [design, toolbar]);
    });
});

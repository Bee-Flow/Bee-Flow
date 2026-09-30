/**
 * The document editor against canned answers: the object header and the web
 * editor's tabs, the text edited in place and autosaved with the revision it
 * was based on, the PDF fetched through the session, the parameters, the
 * line items with their sum, the history, and a presentation's outline.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { StudioDocumentScreen } from './StudioDocumentScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn(async () => 'file:///cache/x.pdf') }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const p = (key: string, type: string, label: string, extra: object = {}) => ({ key, type, label, required: true, summary: label, instructions: 'Verified.', ...extra });
const INVOICE = {
    id: 'd1',
    name: 'Invoice ACME',
    docType: 'invoice',
    kind: 'document',
    visibility: 'private',
    versionId: 'v1',
    editable: true,
    bodyHtml: '<h1>Invoice</h1><section data-doc-section="overview"><h2>{{customer.name}}</h2></section><table><tbody>{{#each lines}}<tr><td>{{amount}}</td></tr>{{/each}}</tbody></table>',
    css: '',
    settings: { sampleValues: { lines: [{ description: 'Design', amount: 100 }, { description: 'Build', amount: 250.5 }] } },
    contract: {
        instructions: '',
        parameters: [p('customer.name', 'text', 'Customer name'), p('lines', 'list', 'Line items', { fields: [p('description', 'text', 'Description'), p('amount', 'number', 'Amount')] })],
        sections: [{ id: 'overview', title: 'Overview', summary: '', condition: null }],
    },
};
const DECK = { ...INVOICE, id: 'd2', name: 'Pitch', docType: 'presentation', bodyHtml: '# {{title}}\n\n## The challenge\n- …', contract: { instructions: '', parameters: [], sections: [] } };

const get = api.get as jest.Mock;
const patch = api.patch as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    get.mockImplementation((path: string) => {
        if (path === '/api/studio-documents/d1') return Promise.resolve({ document: INVOICE });
        if (path === '/api/studio-documents/d2') return Promise.resolve({ document: DECK });
        if (path.endsWith('/versions')) return Promise.resolve({ versions: [{ id: 'v0', summary: 'Created', createdAt: '2026-09-01T10:00:00Z' }] });
        return Promise.reject(new Error(`unexpected ${path}`));
    });
    patch.mockImplementation((_path: string, body: Record<string, unknown>) => Promise.resolve({ document: { ...INVOICE, ...body, versionId: 'v2' } }));
});

const renderEditor = (id = 'd1') => renderScreen(<StudioDocumentScreen documentId={id} />);

describe('StudioDocumentScreen', () => {
    it('opens with the header, the tabs and the text to edit', async () => {
        await renderEditor();
        expect(await screen.findByText('Invoice ACME')).toBeTruthy();
        for (const tab of ['Text', 'Parameters', 'Sections', 'Design', 'Customer preview', 'History']) expect(screen.getByText(tab)).toBeTruthy();
        expect(screen.getByDisplayValue('Invoice')).toBeTruthy();
        expect(screen.getByText('Heading 2 · Overview')).toBeTruthy();
        expect(screen.getByText('{{#each lines}}')).toBeTruthy();
    });

    it('saves an edit in place, naming the revision it was based on', async () => {
        await renderEditor();
        fireEvent.changeText(await screen.findByDisplayValue('Invoice'), 'Factuur & co');
        await waitFor(() => expect(patch).toHaveBeenCalled(), { timeout: 4000 });
        const [path, body] = patch.mock.calls[0] as [string, { bodyHtml: string; expectedVersionId: string }];
        expect(path).toBe('/api/studio-documents/d1');
        expect(body.expectedVersionId).toBe('v1');
        expect(body.bodyHtml).toBe(INVOICE.bodyHtml.replace('<h1>Invoice</h1>', '<h1>Factuur &amp; co</h1>'));
    });

    it('downloads the PDF through the session', async () => {
        await renderEditor();
        fireEvent.press(await screen.findByText('PDF'));
        await waitFor(() => expect(shareServerFile).toHaveBeenCalledWith('/api/studio-documents/d1/pdf', 'Invoice-ACME.pdf', 'application/pdf'));
    });

    it('lists the parameters and fills the line items with their sum', async () => {
        await renderEditor();
        fireEvent.press(await screen.findByText('Parameters'));
        expect(await screen.findByText('Customer name *')).toBeTruthy();
        expect(screen.getByText('List · Line items')).toBeTruthy();
        fireEvent.press(screen.getByText('Customer preview'));
        expect(await screen.findByText('Sum of Amount: 350.5')).toBeTruthy();
        expect(screen.getByDisplayValue('Build')).toBeTruthy();
    });

    it('shows the history', async () => {
        await renderEditor();
        fireEvent.press(await screen.findByText('History'));
        expect(await screen.findByText('Created')).toBeTruthy();
        expect(screen.getByLabelText('Restore this version')).toBeTruthy();
    });

    it('edits a presentation as its outline', async () => {
        await renderEditor('d2');
        expect(await screen.findByText('Outline')).toBeTruthy();
        expect(screen.queryByText('Design')).toBeNull();
        expect(screen.getByDisplayValue(DECK.bodyHtml)).toBeTruthy();
        await act(async () => fireEvent.press(screen.getByText('How to write slides')));
        expect(screen.getByText('## Heading')).toBeTruthy();
    });
});

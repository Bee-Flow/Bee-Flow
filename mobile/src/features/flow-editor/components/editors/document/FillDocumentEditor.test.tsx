/**
 * Fill in a document on screen: a document is picked from your own list,
 * its placeholders become the value rows (a number typed into a number
 * stays a number), an optional section can be forced, a newer revision is
 * reviewed before it is pinned, a presentation asks for its format, and a
 * document that cannot be read leaves the stored values editable.
 */

import { fireEvent, screen } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { getByShownText } from '@/features/flow-editor/components/fields/testing';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const get = api.get as jest.Mock;

const TEMPLATES = [
    { id: 'inv', name: 'Invoice', docType: 'invoice', versionId: 'v2', placeholders: [{ key: 'total', kind: 'value' }, { key: 'lines', kind: 'list' }] },
    { id: 'deck', name: 'Pitch', docType: 'presentation', versionId: 'd1', placeholders: [] },
];
const CONTRACT = {
    documentId: 'inv',
    versionId: 'v1',
    name: 'Invoice',
    docType: 'invoice',
    instructions: 'Amounts in euro.',
    parameters: [
        { key: 'total', type: 'number', label: 'Total', required: true, summary: 'The amount due' },
        { key: 'lines', type: 'list', label: 'Lines', fields: [{ key: 'qty' }] },
    ],
    sections: [{ id: 'terms', title: 'Terms', summary: 'For new clients' }],
};

function answer(overrides: { contract?: () => unknown; templates?: unknown[] } = {}) {
    get.mockImplementation(async (url: string, opts?: { query?: Record<string, string> }) => {
        if (url === '/api/studio-documents/templates') return { templates: overrides.templates ?? TEMPLATES };
        if (url.endsWith('/contract')) {
            if (overrides.contract) return overrides.contract();
            // As the document is now: one revision on from the pinned one.
            const pinned = opts?.query?.versionId;
            if (!pinned) return { contract: { ...CONTRACT, versionId: 'v2', instructions: 'Now with VAT.' } };
            return { contract: { ...CONTRACT, versionId: pinned === 'baseline' ? 'v1' : pinned } };
        }
        return {};
    });
}

const step = (over: Record<string, unknown> = {}) => ({ id: 'f1', type: 'fill_document', label: 'Invoice', ...over }) as unknown as FlowNode;

beforeEach(() => {
    jest.clearAllMocks();
    answer();
});

describe('FillDocumentEditor', () => {
    it('picks a document from the list, name and revision riding along', async () => {
        const h = await renderEditor(step());
        expect(screen.getByText('Pick a document first — its placeholders appear here.')).toBeTruthy();
        await fireEvent.press(await screen.findByTestId('fill-document-select'));
        expect(await screen.findByText('2 placeholder(s)')).toBeTruthy();
        expect(screen.getByText('no placeholders')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('fill-document-option-inv'));
        expect(h.patch()).toMatchObject({ documentId: 'inv', documentName: 'Invoice', documentVersionId: 'v2', sectionOverrides: {} });
        // Its contract is read at the revision just pinned, and its rows appear.
        expect(await screen.findByText('Pinned revision: v2')).toBeTruthy();
        expect(screen.getByText('The amount due')).toBeTruthy();
    });

    it('binds the placeholders the document has, typed as the contract says', async () => {
        const h = await renderEditor(step({ documentId: 'inv', documentName: 'Invoice', documentVersionId: 'v1' }));
        expect(await screen.findByText('Amounts in euro.')).toBeTruthy();
        expect(screen.getByText('The amount due')).toBeTruthy();
        expect(screen.getByText('A list, one block per item with qty. Bind it to a whole list — one value and nothing else around it.')).toBeTruthy();
        await fireEvent.changeText(screen.getByPlaceholderText('‹Previous step ▸ Naam›'), '42');
        expect(h.patch()).toMatchObject({ values: { total: 42 } });
    });

    it('forces an optional section in or out', async () => {
        const h = await renderEditor(step({ documentId: 'inv', documentVersionId: 'v1' }));
        await fireEvent.press(await screen.findByTestId('fill-document-section-terms-select'));
        await fireEvent.press(screen.getByTestId('fill-document-section-terms-option-exclude'));
        expect(h.patch()).toMatchObject({ sectionOverrides: { terms: 'exclude' } });
    });

    it('reviews a newer revision before pinning it', async () => {
        const h = await renderEditor(step({ documentId: 'inv', documentVersionId: 'v1' }));
        expect(await screen.findByText('Pinned revision: v1')).toBeTruthy();
        await fireEvent.press(await screen.findByTestId('fill-document-review-update'));
        expect(await screen.findByText('Now with VAT.')).toBeTruthy();
        expect(screen.getByText('total * — The amount due')).toBeTruthy();
        expect(screen.getByText('Terms: For new clients')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('fill-document-apply-revision'));
        expect(h.patch()).toMatchObject({ documentVersionId: 'v2' });
        expect(screen.queryByTestId('fill-document-review')).toBeNull();
        expect(await screen.findByText('Pinned revision: v2')).toBeTruthy();
        expect(screen.queryByTestId('fill-document-review-update')).toBeNull();
    });

    it('asks a presentation for its format, PowerPoint until PDF is chosen', async () => {
        answer({ contract: () => ({ contract: { ...CONTRACT, documentId: 'deck', docType: 'presentation', parameters: [], sections: [] } }) });
        const h = await renderEditor(step({ documentId: 'deck', documentVersionId: 'd1' }));
        expect(await screen.findByText('This document has no placeholders, so it is sent exactly as designed. Add {{name}} markers to it in Studio → Documents to fill it per run.')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'The file' }));
        await fireEvent.press(screen.getByRole('button', { name: 'Format: PowerPoint (.pptx)' }));
        await fireEvent.press(screen.getByText('PDF deck'));
        expect(h.patch()).toMatchObject({ format: 'pdf' });
    });

    it('keeps the stored values editable when the document cannot be read', async () => {
        answer({
            templates: [],
            contract: () => {
                throw new Error('gone');
            },
        });
        const h = await renderEditor(step({ documentId: 'lost', documentName: 'Old quote', values: { naam: 'Ann' } }));
        expect(await screen.findByText('Could not load your documents.')).toBeTruthy();
        expect(screen.getByText('Old quote')).toBeTruthy();
        await fireEvent.changeText(getByShownText('Ann'), 'Bea');
        expect(h.patch()).toMatchObject({ values: { naam: 'Bea' } });
    });

    it('says how to make a document when there is none', async () => {
        answer({ templates: [] });
        await renderEditor(step());
        expect(
            await screen.findByText('You have no documents yet. Design the invoice, quote or letter in Studio → Documents — write {{customer.name}} where a value should land — and it appears here.'),
        ).toBeTruthy();
    });
});

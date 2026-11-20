import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import type { FillDocument, FillProgress, TemplateFillApi } from '@/api/templateFillApi';
import TemplateFillCard from './TemplateFillCard';
import { templateFillRefs } from './templateFillResults';

/**
 * The form under an answer that fills in a template. It finds its documents in
 * the turn's tool results, or after a reload in their cut-off previews, reads
 * each document through the API and saves what the person types.
 */

const DOC: FillDocument = {
    id: 'd1', name: 'Offer Van Dijk', url: '/app/studio/documents/d1', format: 'pdf', editable: true, finished: false,
    fields: [
        { key: 'client', type: 'text', label: 'Client name', required: true },
        { key: 'amount', type: 'number', label: 'Amount', required: true, example: 1250 },
        { key: 'notes', type: 'text', label: 'Notes', required: false },
    ],
    values: { client: 'Van Dijk' },
};
const PREVIEW = { name: 'template_fill_set_values', resultPreview: '{"documentId":"d1","name":"Offer Van Dijk","url":"/app/stu' };

function progress(over: Partial<FillProgress> = {}): FillProgress {
    return { values: {}, missingRequired: [], issues: [], rejected: [], complete: true, filled: 2, total: 3, finished: false, ...over };
}

function fakeApi(over: Partial<TemplateFillApi> = {}): TemplateFillApi {
    return { load: vi.fn().mockResolvedValue(DOC), save: vi.fn().mockResolvedValue(progress()), download: vi.fn().mockResolvedValue(undefined), ...over };
}

function renderCard(ui: ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('templateFillRefs', () => {
    it('finds the document in live results and in the cut-off previews of a reloaded answer', () => {
        expect(templateFillRefs([{ name: 'template_fill_start', result: { documentId: 'd1' } }, { name: 'web_search', result: { documentId: 'x' } },
            { name: 'template_fill_set_values', result: JSON.stringify({ documentId: 'd1' }) }], undefined)).toEqual([{ documentId: 'd1', revision: 2 }]);
        expect(templateFillRefs(undefined, [PREVIEW, { name: 'template_fill_status', resultPreview: '{"error":"No template"}' }])).toEqual([{ documentId: 'd1', revision: 1 }]);
        expect(templateFillRefs(undefined, undefined)).toEqual([]);
    });
});

describe('<TemplateFillCard>', () => {
    it('rebuilds the form after a reload from the document id: name, progress, every field, download waits for the required ones', async () => {
        const api = fakeApi();
        renderCard(<TemplateFillCard toolHistory={[PREVIEW]} api={api} />);
        expect(await screen.findByText('Offer Van Dijk')).toBeInTheDocument();
        expect(api.load).toHaveBeenCalledWith('d1');
        expect(screen.getByTestId('template-fill-progress').textContent).toBe('1 of 3 fields filled in');
        expect(screen.getByLabelText(/Amount/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Notes/)).toBeInTheDocument();
        expect(screen.getByTestId('template-fill-download')).toBeDisabled();
        expect(screen.getByTestId('document-link-card').textContent).toContain('Open in Documents');
    });

    it('saves a typed value through the API and shows the reason next to a value that does not fit', async () => {
        const user = userEvent.setup();
        const api = fakeApi({ save: vi.fn().mockResolvedValue(progress({ complete: false, rejected: [{ key: 'amount', message: 'Amount is too high.' }], missingRequired: [{ key: 'amount', label: 'Amount' }] })) });
        renderCard(<TemplateFillCard toolHistory={[PREVIEW]} api={api} />);
        await user.type(await screen.findByLabelText(/Amount/), '99999');
        await user.tab();
        await waitFor(() => expect(api.save).toHaveBeenCalledWith('d1', { amount: 99999 }, false));
        expect(await screen.findByText('Amount is too high.')).toBeInTheDocument();
        expect(screen.getByTestId('template-fill-save-state').textContent).toBe('Saved');
    });

    it('Done is refused with what is missing; once complete, the download is offered', async () => {
        const user = userEvent.setup();
        const save = vi.fn()
            .mockResolvedValueOnce(progress({ complete: false, missingRequired: [{ key: 'amount', label: 'Amount' }] }))
            .mockResolvedValueOnce(progress({ complete: true, finished: true, filled: 3 }));
        const api = fakeApi({ save });
        renderCard(<TemplateFillCard toolHistory={[PREVIEW]} api={api} />);
        await user.click(await screen.findByTestId('template-fill-done'));
        expect(save).toHaveBeenCalledWith('d1', {}, true);
        expect(await screen.findByRole('alert')).toHaveTextContent('Still needed before it is done: Amount');

        await user.click(screen.getByTestId('template-fill-done'));
        await waitFor(() => expect(screen.getByTestId('template-fill-download')).toBeEnabled());
        expect(screen.queryByTestId('template-fill-done')).not.toBeInTheDocument();
        await user.click(screen.getByTestId('template-fill-download'));
        expect(api.download).toHaveBeenCalledWith('d1', 'Offer Van Dijk', 'pdf');
    });

    it('renders nothing for a turn without template results', () => {
        const { container } = renderCard(<TemplateFillCard toolResults={[{ name: 'web_search', result: {} }]} />);
        expect(container).toBeEmptyDOMElement();
    });
});

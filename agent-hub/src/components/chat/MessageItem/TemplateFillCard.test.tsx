import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import type { FillDocument, FillProgress, TemplateFillApi } from '@/api/templateFillApi';
import { NO_TEAM, type FillFinding, type FillTeam } from '@/api/templateFillTeamApi';
import TemplateFillCard from './TemplateFillCard';
import TemplateFillForm from './TemplateFillForm';
import { templateFillRefs } from './templateFillResults';

/**
 * The form under an answer that fills in a template. It finds its documents in
 * the turn's tool results, or after a reload in their cut-off previews, reads
 * each document through the API, saves what the person types, lets the
 * assistant check it, and finishes it.
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
const FULL: FillDocument = { ...DOC, values: { client: 'Van Dijk', amount: 10 } };
const PREVIEW = { name: 'template_fill_set_values', resultPreview: '{"documentId":"d1","name":"Offer Van Dijk","url":"/app/stu' };

function progress(over: Partial<FillProgress> = {}): FillProgress {
    return { values: {}, missingRequired: [], issues: [], rejected: [], complete: true, filled: 2, total: 3, finished: false, ...over };
}

const reviewed = (findings: FillFinding[]): FillTeam => ({ ...NO_TEAM, review: { at: '2026-11-23T09:00:00.000Z', checked: 2, findings } });

function fakeApi(over: Partial<TemplateFillApi> = {}): TemplateFillApi {
    return {
        load: vi.fn().mockResolvedValue(DOC), save: vi.fn().mockResolvedValue(progress()), download: vi.fn().mockResolvedValue(undefined),
        review: vi.fn().mockResolvedValue(progress({ team: reviewed([]) })), ...over,
    };
}

function renderCard(ui: ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (node: ReactNode) => <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
    const view = render(wrap(ui));
    return { ...view, rerender: (node: ReactNode) => view.rerender(wrap(node)) };
}

const guide = () => screen.getByTestId('template-fill-guide');

describe('templateFillRefs', () => {
    it('finds the document in live results and in the cut-off previews of a reloaded answer', () => {
        expect(templateFillRefs([{ name: 'template_fill_start', result: { documentId: 'd1' } }, { name: 'web_search', result: { documentId: 'x' } },
            { name: 'template_fill_set_values', result: JSON.stringify({ documentId: 'd1' }) }], undefined)).toEqual([{ documentId: 'd1', revision: 2 }]);
        expect(templateFillRefs(undefined, [PREVIEW, { name: 'template_fill_status', resultPreview: '{"error":"No template"}' }])).toEqual([{ documentId: 'd1', revision: 1 }]);
        expect(templateFillRefs(undefined, undefined)).toEqual([]);
    });
});

describe('<TemplateFillCard>', () => {
    it('rebuilds the form after a reload from the document id: name, progress, what to do next, every field, download waits for the required ones', async () => {
        const api = fakeApi();
        renderCard(<TemplateFillCard toolHistory={[PREVIEW]} api={api} />);
        expect(await screen.findByText('Offer Van Dijk')).toBeInTheDocument();
        expect(api.load).toHaveBeenCalledWith('d1');
        expect(screen.getByTestId('template-fill-progress').textContent).toBe('1 of 3 fields filled in');
        expect(guide()).toHaveAttribute('data-step', 'missing');
        expect(guide()).toHaveTextContent('1 required field is still empty. Fill it in under “Still needed”, or tell the assistant in the chat.');
        expect(screen.getByLabelText(/Amount/)).toBeInTheDocument();
        // What is filled in or optional waits folded away while something is still needed.
        expect(screen.queryByLabelText(/Notes/)).not.toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: /Optional/ }));
        expect(screen.getByLabelText(/Notes/)).toBeInTheDocument();
        // Nothing to download yet, so no download is offered; and while fields are missing the finishing button is the quiet one.
        expect(screen.queryByTestId('template-fill-download')).not.toBeInTheDocument();
        expect(screen.getByTestId('template-fill-open')).toHaveAttribute('title', 'Open in Documents');
        expect(screen.getByTestId('template-fill-stages')).toHaveTextContent('1Fill in2Check3Done');
        expect(within(screen.getByTestId('template-fill-stages')).getByText('Fill in').closest('li')).toHaveAttribute('aria-current', 'step');
    });

    it('saves a typed value through the API and shows the reason next to a value that does not fit', async () => {
        const user = userEvent.setup();
        const api = fakeApi({ save: vi.fn().mockResolvedValue(progress({ complete: false, rejected: [{ key: 'amount', message: 'Amount is too high.' }], missingRequired: [{ key: 'amount', label: 'Amount' }] })) });
        renderCard(<TemplateFillCard toolHistory={[PREVIEW]} api={api} />);
        await user.type(await screen.findByLabelText(/Amount/), '99999');
        await user.tab();
        await waitFor(() => expect(api.save).toHaveBeenCalledWith('d1', { amount: 99999 }, {}));
        expect(await screen.findByText('Amount is too high.')).toBeInTheDocument();
        expect(screen.getByTestId('template-fill-save-state').textContent).toBe('Saved');
    });

    it('"Check and finish" says what is missing and asks the assistant nothing while a required field is empty', async () => {
        const user = userEvent.setup();
        const api = fakeApi();
        renderCard(<TemplateFillCard toolHistory={[PREVIEW]} api={api} />);
        await user.click(await screen.findByRole('button', { name: 'Check and finish' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Still needed before it is done: Amount');
        expect(api.review).not.toHaveBeenCalled();
        expect(api.save).not.toHaveBeenCalled();
    });

    it('only the last answer about a document carries its form; the earlier ones point to it', async () => {
        const api = fakeApi();
        renderCard(<><TemplateFillCard toolHistory={[PREVIEW]} api={api} /><TemplateFillCard toolHistory={[PREVIEW]} api={api} /></>);
        expect(await screen.findByText('Offer Van Dijk')).toBeInTheDocument();
        expect(screen.getAllByTestId('template-fill-card')).toHaveLength(1);
        const slots = screen.getAllByTestId('template-fill-slot');
        expect(within(slots[0]).getByTestId('template-fill-earlier')).toHaveTextContent('The form continues under a later answer');
        expect(within(slots[1]).getByTestId('template-fill-card')).toBeInTheDocument();
        expect(api.load).toHaveBeenCalledTimes(1);
    });

    it('a new answer of the assistant in the same turn brings its values in without throwing away what the person is typing', async () => {
        const user = userEvent.setup();
        const load = vi.fn().mockResolvedValueOnce({ ...DOC, values: {} }).mockResolvedValueOnce({ ...DOC, values: { client: 'Stored by the assistant', notes: 'Also stored' } });
        const api = fakeApi({ load, save: vi.fn().mockReturnValue(new Promise(() => {})) });
        const live = (n: number) => Array.from({ length: n }, () => ({ name: 'template_fill_set_values', result: { documentId: 'd1' } }));
        const view = renderCard(<TemplateFillCard toolResults={live(1)} api={api} />);
        await user.type(await screen.findByLabelText(/Amount/), '42');
        view.rerender(<TemplateFillCard toolResults={live(2)} api={api} />);
        await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getByTestId('template-fill-progress').textContent).toBe('2 of 3 fields filled in'));
        expect(screen.getByLabelText(/Amount/)).toHaveValue(42);
        expect(screen.getByLabelText(/Amount/)).toHaveFocus();
    });

    it('what was typed and not saved yet is sent when the form goes away', async () => {
        const user = userEvent.setup();
        const api = fakeApi();
        const view = renderCard(<TemplateFillCard toolHistory={[PREVIEW]} api={api} />);
        await user.type(await screen.findByLabelText(/Amount/), '7{Enter}');
        expect(api.save).not.toHaveBeenCalled();
        view.unmount();
        expect(api.save).toHaveBeenCalledWith('d1', { amount: 7 });
    });

    it('renders nothing for a turn without template results', () => {
        const { container } = renderCard(<TemplateFillCard toolResults={[{ name: 'web_search', result: {} }]} />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('<TemplateFillForm> the final check', () => {
    const rewrite: FillFinding = { key: 'client', kind: 'rewrite', suggestion: 'Van Dijk Groep B.V.', reason: 'The full legal name.' };
    const doubt: FillFinding = { key: 'amount', kind: 'doubt', reason: 'Very low for an offer.' };

    it('checks once before finishing, shows each remark at its field, and finishes after the person dealt with them', async () => {
        const user = userEvent.setup();
        const save = vi.fn()
            .mockResolvedValueOnce(progress({ team: reviewed([doubt]) }))
            .mockResolvedValueOnce(progress({ team: reviewed([]) }))
            .mockResolvedValueOnce(progress({ team: reviewed([]), finished: true }));
        const api = fakeApi({ save, review: vi.fn().mockResolvedValue(progress({ team: reviewed([rewrite, doubt]) })) });
        renderCard(<TemplateFillForm doc={FULL} api={api} />);
        expect(guide()).toHaveAttribute('data-step', 'check');
        await user.click(screen.getByRole('button', { name: 'Check and finish' }));
        expect(api.review).toHaveBeenCalledWith('d1');
        expect(save).not.toHaveBeenCalled();

        // Not finished: the remarks come first, in their own group, each at its field.
        const group = await screen.findByTestId('template-fill-group-remarked');
        expect(guide()).toHaveTextContent('The check has 2 remarks. Go through them at their fields, then finish.');
        expect(within(group).getByTestId('template-fill-remark-client')).toHaveTextContent('Suggested wording The full legal name.Van Dijk Groep B.V.');
        expect(within(group).getByTestId('template-fill-remark-amount')).toHaveTextContent('Is this right? Very low for an offer.');

        // The better wording is taken over with one click: a plain save of that value.
        await user.click(screen.getByRole('button', { name: 'Use this' }));
        await waitFor(() => expect(save).toHaveBeenCalledWith('d1', { client: 'Van Dijk Groep B.V.' }, {}));
        // Dealt with: the field is with the filled-in ones again, one remark left to look at.
        expect(within(screen.getByTestId('template-fill-group-remarked')).queryByLabelText(/Client name/)).not.toBeInTheDocument();
        // The doubted value is right after all: the remark goes, the value stays.
        await user.click(screen.getByRole('button', { name: 'It is right' }));
        await waitFor(() => expect(save).toHaveBeenCalledWith('d1', {}, { dismiss: ['amount'] }));
        expect(screen.queryByTestId('template-fill-group-remarked')).not.toBeInTheDocument();
        expect(screen.getByLabelText(/Client name/)).toHaveValue('Van Dijk Groep B.V.');
        expect(screen.getByLabelText(/Amount/)).toHaveValue(10);

        // Checked: the button now finishes, without a second check.
        await user.click(screen.getByRole('button', { name: 'Finish' }));
        await waitFor(() => expect(save).toHaveBeenLastCalledWith('d1', {}, { finish: true }));
        await waitFor(() => expect(screen.queryByTestId('template-fill-done')).not.toBeInTheDocument());
        expect(api.review).toHaveBeenCalledTimes(1);
        expect(guide()).toHaveTextContent('Finished. Download it, or save it in a project.');
        await user.click(screen.getByTestId('template-fill-download'));
        expect(api.download).toHaveBeenCalledWith('d1', 'Offer Van Dijk', 'pdf');
    });

    it('a check that finds nothing finishes in the same click', async () => {
        const user = userEvent.setup();
        const save = vi.fn().mockResolvedValue(progress({ team: reviewed([]), finished: true }));
        const api = fakeApi({ save });
        renderCard(<TemplateFillForm doc={FULL} api={api} />);
        await user.click(screen.getByRole('button', { name: 'Check and finish' }));
        await waitFor(() => expect(save).toHaveBeenCalledWith('d1', {}, { finish: true }));
        expect(await screen.findByLabelText('Finished')).toBeInTheDocument();
        // Finished: the fields fold away (a click opens them again), and what is left is the download.
        expect(screen.queryByLabelText(/Amount/)).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Filled in \(2\)/ }));
        expect(screen.getByLabelText(/Amount/)).toHaveValue(10);
        expect(screen.getByTestId('template-fill-download')).toBeEnabled();
        expect(within(screen.getByTestId('template-fill-stages')).getByText('Done').closest('li')).toHaveAttribute('aria-current', 'step');
    });

    it('when the assistant cannot check it, the form says so and still lets the person finish', async () => {
        const user = userEvent.setup();
        const save = vi.fn().mockResolvedValue(progress({ finished: true }));
        const api = fakeApi({ save, review: vi.fn().mockRejectedValue(new Error('No AI model is configured, so the check could not run.')) });
        renderCard(<TemplateFillForm doc={FULL} api={api} />);
        await user.click(screen.getByRole('button', { name: 'Check and finish' }));
        expect(await screen.findByTestId('template-fill-check-failed')).toHaveTextContent('The assistant could not check it now. No AI model is configured');
        expect(save).not.toHaveBeenCalled();
        expect(guide()).toHaveTextContent('Everything needed is filled in. You can finish it.');
        await user.click(screen.getByRole('button', { name: 'Finish' }));
        await waitFor(() => expect(save).toHaveBeenCalledWith('d1', {}, { finish: true }));
    });

    it('a document that was checked before (by the assistant in the chat, say) opens with its remarks and offers another check', async () => {
        const user = userEvent.setup();
        const api = fakeApi();
        renderCard(<TemplateFillForm doc={{ ...FULL, team: reviewed([doubt]) }} api={api} />);
        expect(screen.getByTestId('template-fill-remark-amount')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Check again' }));
        expect(api.review).toHaveBeenCalledWith('d1');
    });

    it('a reader who may not change the document sees the remarks, and no way to act on them', () => {
        renderCard(<TemplateFillForm doc={{ ...FULL, editable: false, team: reviewed([rewrite]) }} api={fakeApi()} />);
        expect(guide()).toHaveTextContent('You can read this document, but not change it.');
        expect(screen.getByTestId('template-fill-remark-client')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Use this' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('template-fill-done')).not.toBeInTheDocument();
    });
});

describe('the field the person is at, for a preview next to the form', () => {
    const WITH_DEFAULT: FillDocument = {
        ...DOC, values: {},
        fields: [...DOC.fields, { key: 'plan', type: 'text', label: 'Plan', required: false, suggestion: 'Plus plan' }],
    };

    it('names the passage as the document prints it: the label in brackets while needed, the default, or nothing', async () => {
        const user = userEvent.setup();
        const onSpot = vi.fn();
        renderCard(<TemplateFillForm doc={WITH_DEFAULT} api={fakeApi()} onSpot={onSpot} />);
        await user.click(screen.getByLabelText(/Amount/));
        expect(onSpot).toHaveBeenLastCalledWith('[Amount]');
        await user.click(screen.getByRole('button', { name: /Optional/ }));
        await user.click(screen.getByLabelText(/Plan/));
        expect(onSpot).toHaveBeenLastCalledWith('Plus plan');
        // An empty optional field without a default prints nothing: there is no passage to point at.
        await user.click(screen.getByLabelText(/Notes/));
        expect(onSpot).toHaveBeenLastCalledWith('');
    });

    it('follows the value once it is in the field for good (Enter), not every keystroke', async () => {
        const user = userEvent.setup();
        const onSpot = vi.fn();
        renderCard(<TemplateFillForm doc={WITH_DEFAULT} api={fakeApi()} onSpot={onSpot} />);
        await user.type(screen.getByLabelText(/Client name/), 'Van Dijk');
        expect(onSpot).toHaveBeenLastCalledWith('[Client name]');
        await user.keyboard('{Enter}');
        await waitFor(() => expect(onSpot).toHaveBeenLastCalledWith('Van Dijk'));
    });

    it('leaves a value too short to find in the right place alone', async () => {
        const user = userEvent.setup();
        const onSpot = vi.fn();
        renderCard(<TemplateFillForm doc={{ ...WITH_DEFAULT, values: { client: 'Van', amount: 5 } }} api={fakeApi()} onSpot={onSpot} />);
        await user.click(screen.getByLabelText(/Client name/));
        expect(onSpot).toHaveBeenLastCalledWith('');
    });
});

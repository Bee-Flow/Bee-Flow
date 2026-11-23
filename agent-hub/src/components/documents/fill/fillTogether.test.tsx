import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import type { FilingApi } from '@/api/documentFilingApi';
import type { FillDocument, FillProgress, TemplateFillApi } from '@/api/templateFillApi';
import { NO_TEAM, type FillTeam, type FillTeamApi, type ValueRequest } from '@/api/templateFillTeamApi';
import TemplateFillForm from '@/components/chat/MessageItem/TemplateFillForm';
import DocumentFillPanel from './DocumentFillPanel';
import type { FillPeople } from './TeamBlock';

/**
 * Filling in a document together in a project: what colleagues asked, tagging
 * a colleague at a field, notes for each other, and where the document is
 * kept (a project, and a folder of it).
 */

const DOC: FillDocument = {
    id: 'd1', name: 'Offer Van Dijk', url: '/app/projects/p1/documents/d1', format: 'pdf', editable: true, finished: false, projectId: 'p1',
    fields: [
        { key: 'client', type: 'text', label: 'Client name', required: true },
        { key: 'amount', type: 'number', label: 'Amount', required: true },
        { key: 'iban', type: 'text', label: 'IBAN', required: false },
    ],
    values: {},
};
const NAMES: Record<string, string> = { me: 'you', bob: 'Bob', ann: 'Ann' };
const PEOPLE: FillPeople = { nameOf: (id) => NAMES[id] || 'a colleague', colleagues: [{ id: 'bob', name: 'Bob' }] };

const request = (over: Partial<ValueRequest> = {}): ValueRequest => ({ id: 'r1', fields: ['amount'], assigneeId: 'bob', requestedBy: 'me', message: '', createdAt: 'x', ...over });
const team = (over: Partial<FillTeam> = {}): FillTeam => ({ ...NO_TEAM, ...over });

function progress(over: Partial<FillProgress> = {}): FillProgress {
    return { values: {}, missingRequired: [], issues: [], rejected: [], complete: false, filled: 0, total: 3, finished: false, ...over };
}

function fakeTeamApi(over: Partial<FillTeamApi> = {}): FillTeamApi {
    return {
        ask: vi.fn().mockResolvedValue(team({ requests: [request({ message: 'Incl. VAT' })] })),
        closeRequest: vi.fn().mockResolvedValue(team()),
        addNote: vi.fn().mockResolvedValue(team({ notes: [{ id: 'n1', key: 'amount', userId: 'me', text: 'Still being negotiated.', at: 'now' }] })),
        removeNote: vi.fn().mockResolvedValue(team()),
        ...over,
    };
}

function fakeFiling(over: Partial<FilingApi> = {}): FilingApi {
    return {
        targets: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Van Dijk' }, { id: 'p2', name: 'Internal' }]),
        add: vi.fn().mockResolvedValue(undefined),
        folders: vi.fn().mockResolvedValue({ folders: [{ id: 'f1', name: 'Customers', createdBy: 'me', createdAt: 'x' }], placements: {} }),
        place: vi.fn().mockResolvedValue({ id: 'f9', name: 'Van Dijk BV' }),
        ...over,
    };
}

function fakeApi(over: Partial<TemplateFillApi> = {}): TemplateFillApi {
    return {
        load: vi.fn().mockResolvedValue(DOC), save: vi.fn().mockResolvedValue(progress()), download: vi.fn().mockResolvedValue(undefined),
        review: vi.fn().mockResolvedValue(progress()), team: fakeTeamApi(), filing: fakeFiling(), ...over,
    };
}

function show(ui: ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const field = (key: string) => screen.getByTestId(`template-fill-field-${key}`);

describe('filling in together', () => {
    it('what a colleague asked of the reader comes first, with who asked and what they said', () => {
        const doc = { ...DOC, team: team({ requests: [request({ fields: ['iban'], assigneeId: 'me', requestedBy: 'ann', message: 'For the invoice' })] }) };
        show(<TemplateFillForm doc={doc} api={fakeApi()} meId="me" people={PEOPLE} />);
        expect(screen.getByTestId('template-fill-guide')).toHaveTextContent('A colleague is waiting for 1 field from you. It is at the top, under “Asked of you”.');
        expect(within(screen.getByTestId('template-fill-fields')).getAllByRole('region')[0]).toHaveAttribute('data-testid', 'template-fill-group-asked');
        expect(within(screen.getByTestId('template-fill-group-asked')).getByLabelText('IBAN')).toBeInTheDocument();
        expect(screen.getByTestId('value-request-list')).toHaveTextContent('Ann asks you: IBAN“For the invoice”');
        expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument();
    });

    it('takes a colleague\'s value from the next read, keeps the field this person is saving, and says who filled in what', async () => {
        const user = userEvent.setup();
        let remote: Partial<FillDocument> = {};
        const api = fakeApi({
            // The colleague saves only once this person has started typing (remote is set below).
            load: vi.fn().mockImplementation(async () => ({ ...DOC, ...remote })),
            // The save stays on its way: the poll must not put the old amount back meanwhile.
            save: vi.fn().mockReturnValue(new Promise(() => {})),
        });
        show(<TemplateFillForm doc={DOC} api={api} live={{ pollMs: 40 }} meId="me" people={PEOPLE} />);
        await user.type(screen.getByLabelText(/Amount/), '1');
        remote = { values: { client: 'Remote BV', amount: 99 }, team: team({ filledBy: { client: { userId: 'bob', at: 'now' } } }) };
        // A colleague's read arrives while the person is still typing in the field: their typing stays.
        await waitFor(() => expect(screen.getByTestId('template-fill-progress').textContent).toBe('2 of 3 fields filled in'), { timeout: 2000 });
        expect(screen.getByLabelText(/Amount/)).toHaveValue(1);
        await user.type(screen.getByLabelText(/Amount/), '2');
        await user.tab();
        await waitFor(() => expect(api.save).toHaveBeenCalledWith('d1', { amount: 12 }, {}), { timeout: 2000 });
        expect(screen.getByLabelText(/Amount/)).toHaveValue(12);
        await user.click(screen.getByRole('button', { name: /Filled in/ }));
        expect(screen.getByLabelText(/Client name/)).toHaveValue('Remote BV');
        expect(screen.getByTestId('template-fill-note-client').textContent).toBe('Filled in by Bob');
    });

    it('a colleague is tagged at the field: that field and the only colleague are chosen already, and the request shows at once', async () => {
        const user = userEvent.setup();
        const api = fakeApi();
        show(<TemplateFillForm doc={DOC} api={api} meId="me" people={PEOPLE} />);
        await user.click(within(field('amount')).getByRole('button', { name: 'Ask a colleague' }));
        const form = screen.getByTestId('value-request-form');
        expect(within(form).getByRole('checkbox', { name: 'Amount' })).toBeChecked();
        expect(within(form).getByRole('checkbox', { name: 'Client name' })).not.toBeChecked();
        expect(within(form).getByRole('checkbox', { name: 'Bob' })).toBeChecked();
        await user.type(within(form).getByRole('textbox'), 'Incl. VAT');
        await user.click(within(form).getByRole('button', { name: 'Send request' }));
        await waitFor(() => expect(api.team?.ask).toHaveBeenCalledWith('d1', ['amount'], ['bob'], 'Incl. VAT'));
        expect(await screen.findByTestId('value-request-list')).toHaveTextContent('Waiting for Bob: Amount“Incl. VAT”');
        expect(screen.queryByTestId('value-request-form')).not.toBeInTheDocument();
        expect(screen.getByTestId('template-fill-note-amount').textContent).toBe('Asked of Bob');
        expect(screen.getByTestId('template-fill-guide')).toHaveTextContent('2 required fields are still empty. 1 of them is asked of a colleague.');
        // Asked already, and nothing to ask for at a field that has a value: the offer is only at the empty ones.
        expect(within(field('client')).getByRole('button', { name: 'Ask a colleague' })).toBeInTheDocument();
    });

    it('a request that could not be sent says why, and stays open to try again', async () => {
        const user = userEvent.setup();
        const api = fakeApi({ team: fakeTeamApi({ ask: vi.fn().mockRejectedValue(new Error('Only people who may edit this project can be asked.')) }) });
        show(<TemplateFillForm doc={DOC} api={api} meId="me" people={PEOPLE} />);
        await user.click(screen.getByTestId('value-request-open'));
        await user.click(screen.getByRole('button', { name: 'Send request' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Only people who may edit this project can be asked.');
        expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled();
    });

    it('a note is left at a field for the others, and its writer takes it away again', async () => {
        const user = userEvent.setup();
        const api = fakeApi();
        show(<TemplateFillForm doc={DOC} api={api} meId="me" people={PEOPLE} />);
        await user.click(within(field('amount')).getByRole('button', { name: 'Add a note' }));
        await user.type(screen.getByRole('textbox', { name: 'A note for your colleagues about this field' }), 'Still being negotiated.{Enter}');
        await waitFor(() => expect(api.team?.addNote).toHaveBeenCalledWith('d1', 'amount', 'Still being negotiated.'));
        expect(await within(field('amount')).findByTestId('template-fill-notes')).toHaveTextContent('you: Still being negotiated.');
        await user.click(screen.getByRole('button', { name: 'Remove this note' }));
        await waitFor(() => expect(api.team?.removeNote).toHaveBeenCalledWith('d1', 'n1'));
        await waitFor(() => expect(screen.queryByTestId('template-fill-notes')).not.toBeInTheDocument());
    });

    it('a note on the whole document shows above the fields, for everyone', () => {
        const doc = { ...DOC, team: team({ notes: [{ id: 'n2', key: '', userId: 'ann', text: 'The client wants this before Friday.', at: 'now' }] }) };
        show(<TemplateFillForm doc={doc} api={fakeApi()} meId="me" people={PEOPLE} />);
        expect(within(screen.getByTestId('template-fill-team')).getByTestId('template-fill-notes')).toHaveTextContent('Ann: The client wants this before Friday.');
        expect(screen.queryByRole('button', { name: 'Remove this note' })).not.toBeInTheDocument();
    });

    it('a person\'s own document has none of this: no tagging, no notes, only where to keep it', () => {
        show(<TemplateFillForm doc={{ ...DOC, projectId: null, canFile: true }} api={fakeApi()} />);
        expect(screen.queryByTestId('template-fill-team')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Ask a colleague' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save in project' })).toBeInTheDocument();
    });
});

describe('where the filled-in document is kept', () => {
    it('a person\'s own document goes into a project and a new folder of it, in one go', async () => {
        const user = userEvent.setup();
        const api = fakeApi();
        const onFiled = vi.fn();
        show(<TemplateFillForm doc={{ ...DOC, projectId: null, canFile: true }} api={api} onFiled={onFiled} />);
        await user.click(screen.getByRole('button', { name: 'Save in project' }));
        await user.click(await screen.findByRole('button', { name: 'Van Dijk' }));
        const folders = await screen.findByTestId('save-to-project-folders');
        expect(folders).toHaveTextContent('Where in Van Dijk?');
        expect(within(folders).getByRole('radio', { name: /No folder/ })).toBeChecked();
        expect(api.filing?.add).not.toHaveBeenCalled();
        await user.click(within(folders).getByRole('radio', { name: 'A new folder…' }));
        expect(screen.getByTestId('save-to-project-confirm')).toBeDisabled();
        await user.type(screen.getByRole('textbox', { name: 'Name of the new folder' }), 'Van Dijk BV');
        await user.click(screen.getByTestId('save-to-project-confirm'));
        await waitFor(() => expect(api.filing?.add).toHaveBeenCalledWith('p1', 'd1'));
        expect(api.filing?.place).toHaveBeenCalledWith('p1', 'd1', { folderId: null, newName: 'Van Dijk BV' });
        const link = await screen.findByTestId('template-fill-added-to-project');
        expect(link).toHaveTextContent('In project Van Dijk, folder Van Dijk BV');
        expect(link).toHaveAttribute('href', '/app/projects/p1/documents/d1');
        expect(onFiled).toHaveBeenCalledWith('p1');
        expect(screen.queryByRole('button', { name: 'Save in project' })).not.toBeInTheDocument();
    });

    it('a project\'s document is moved between that project\'s folders; the folder it is in is the one chosen', async () => {
        const user = userEvent.setup();
        const filing = fakeFiling({
            folders: vi.fn().mockResolvedValue({ folders: [{ id: 'f1', name: 'Customers', createdBy: 'x', createdAt: 'x' }, { id: 'f2', name: 'Archive', createdBy: 'x', createdAt: 'x' }], placements: { d1: 'f1' } }),
            place: vi.fn().mockResolvedValue({ id: 'f2', name: '' }),
        });
        show(<TemplateFillForm doc={DOC} api={fakeApi({ filing })} meId="me" people={PEOPLE} />);
        // Where it is now is said before anything is clicked.
        expect(await screen.findByTestId('template-fill-added-to-project')).toHaveTextContent('In folder Customers');
        await user.click(screen.getByRole('button', { name: 'Move to another folder' }));
        const folders = await screen.findByTestId('save-to-project-folders');
        expect(filing.targets).not.toHaveBeenCalled();
        expect(within(folders).getByRole('radio', { name: 'Customers' })).toBeChecked();
        await user.click(within(folders).getByRole('radio', { name: 'Archive' }));
        await user.click(screen.getByRole('button', { name: 'Move here' }));
        await waitFor(() => expect(filing.place).toHaveBeenCalledWith('p1', 'd1', { folderId: 'f2' }));
        expect(filing.add).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.getByTestId('template-fill-added-to-project')).toHaveTextContent('In folder Archive'));
        expect(screen.getByRole('button', { name: 'Move to another folder' })).toBeInTheDocument();
    });

    it('a "new" folder by the name of one that exists is that folder: no second folder of the same name', async () => {
        const user = userEvent.setup();
        const filing = fakeFiling({ place: vi.fn().mockResolvedValue({ id: 'f1', name: '' }) });
        show(<TemplateFillForm doc={{ ...DOC, projectId: null, canFile: true }} api={fakeApi({ filing })} />);
        await user.click(screen.getByRole('button', { name: 'Save in project' }));
        await user.click(await screen.findByRole('button', { name: 'Van Dijk' }));
        await user.click(await screen.findByRole('radio', { name: 'A new folder…' }));
        await user.type(screen.getByRole('textbox', { name: 'Name of the new folder' }), ' customers ');
        await user.click(screen.getByTestId('save-to-project-confirm'));
        await waitFor(() => expect(filing.place).toHaveBeenCalledWith('p1', 'd1', { folderId: 'f1' }));
        expect(await screen.findByTestId('template-fill-added-to-project')).toHaveTextContent('In project Van Dijk, folder Customers');
    });

    it('says so when it could not be saved, and nothing claims it was', async () => {
        const user = userEvent.setup();
        const filing = fakeFiling({ add: vi.fn().mockRejectedValue(new Error('Only the owner of a document can add it to a project.')) });
        show(<TemplateFillForm doc={{ ...DOC, projectId: null, canFile: true }} api={fakeApi({ filing })} />);
        await user.click(screen.getByRole('button', { name: 'Save in project' }));
        await user.click(await screen.findByRole('button', { name: 'Internal' }));
        await user.click(await screen.findByTestId('save-to-project-confirm'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner of a document can add it to a project.');
        expect(screen.queryByTestId('template-fill-added-to-project')).not.toBeInTheDocument();
        expect(filing.place).not.toHaveBeenCalled();
    });
});

describe('<DocumentFillPanel>', () => {
    it('reads the document and shows its form, the same in every place; in the editor without "Open in Documents"', async () => {
        const api = fakeApi({ load: vi.fn().mockResolvedValue({ ...DOC, projectId: null, url: '/app/studio/documents/d1', canFile: true }) });
        show(<DocumentFillPanel documentId="d1" api={api} place="editor" />);
        expect(screen.getByText('Loading the form…')).toBeInTheDocument();
        expect(await screen.findByTestId('template-fill-card')).toHaveAttribute('data-phase', 'fill');
        expect(screen.queryByTestId('document-link-card')).not.toBeInTheDocument();
        expect(screen.getByTestId('template-fill-guide')).toHaveTextContent('2 required fields are still empty. Fill them in under “Still needed”.');
    });

    it('says so when the document cannot be read', async () => {
        show(<DocumentFillPanel documentId="gone" api={fakeApi({ load: vi.fn().mockRejectedValue(new Error('404')) })} />);
        expect(await screen.findByText('The form could not be loaded.')).toBeInTheDocument();
    });
});

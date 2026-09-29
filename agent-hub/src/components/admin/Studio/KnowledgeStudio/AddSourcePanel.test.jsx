import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AddSourcePanel from './AddSourcePanel';

// The org's tag vocabulary is a nicety: a tag typed by hand is still a tag,
// and the server checks it either way. Stubbed so the form does not reach the
// network for a datalist.
vi.mock('../../../../pages/meeting-notes/lib/transcriptionsApi', () => ({
    listTranscriptionTags: vi.fn(async () => [{ tag: 'sales', count: 6 }, { tag: 'directie', count: 2 }]),
}));

vi.mock('../Datatables/datatablesApi', () => ({
    datatablesApi: { list: vi.fn(async () => []), getSchema: vi.fn(async () => ({ fields: [] })) },
    default: { list: vi.fn(async () => []), getSchema: vi.fn(async () => ({ fields: [] })) },
}));

beforeEach(() => { vi.clearAllMocks(); });


/**
 * The meeting-tag form (K7).
 *
 * This source moves meeting summaries out of a note's own audience and into
 * the knowledge base's, which may be larger — a colleague who cannot open the
 * note can ask an agent about it. The server holds that line twice, but
 * somebody choosing a tag deserves to know what they are choosing BEFORE they
 * press the button rather than being refused after it.
 */
describe('MeetingTagForm', () => {
    async function openForm() {
        const onCreate = vi.fn().mockResolvedValue({});
        render(<AddSourcePanel canManage onCreate={onCreate} />);
        fireEvent.click(screen.getByTestId('kb-add-kind-meeting_tag'));
        return { onCreate, form: await screen.findByTestId('kb-form-meeting_tag') };
    }

    it('creates a source from a tag, with summary and decisions by default', async () => {
        const { onCreate } = await openForm();
        fireEvent.change(screen.getByTestId('kb-meeting-tag'), { target: { value: 'sales' } });
        fireEvent.click(screen.getByTestId('kb-meeting-submit'));
        await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
            kind: 'meeting_tag',
            config: { tag: 'sales', fields: ['summary', 'decisions'] },
        }));
    });

    it('states the consequence on the form, before the button', async () => {
        // Being refused after choosing teaches nothing about why.
        await openForm();
        expect(screen.getByText(/including people who cannot open the meetings themselves/i)).toBeTruthy();
    });

    it('says transcripts never go in, and does not offer them', async () => {
        // A transcript is the raw record of who said what, full of asides
        // nobody meant to publish. Not offered rather than offered-and-warned.
        await openForm();
        expect(screen.getByText(/Transcripts never go in/i)).toBeTruthy();
        expect(screen.queryByTestId('kb-meeting-field-transcript')).toBeNull();
    });

    it('cannot untick the summary', async () => {
        // A document of decisions with no context is a list of sentences
        // beginning "we agreed to" about nothing.
        await openForm();
        const summary = screen.getByTestId('kb-meeting-field-summary');
        expect(summary.disabled).toBe(true);
        expect(summary.dataset.active).toBe('true');
        fireEvent.click(summary);
        expect(summary.dataset.active).toBe('true');
    });

    it('adds and removes the optional parts', async () => {
        const { onCreate } = await openForm();
        fireEvent.change(screen.getByTestId('kb-meeting-tag'), { target: { value: 'sales' } });
        fireEvent.click(screen.getByTestId('kb-meeting-field-decisions'));   // off
        fireEvent.click(screen.getByTestId('kb-meeting-field-questions'));   // on
        fireEvent.click(screen.getByTestId('kb-meeting-submit'));
        await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
            kind: 'meeting_tag',
            config: { tag: 'sales', fields: ['summary', 'questions'] },
        }));
    });

    it('will not submit without a tag', async () => {
        const { onCreate } = await openForm();
        expect(screen.getByTestId('kb-meeting-submit').disabled).toBe(true);
        fireEvent.change(screen.getByTestId('kb-meeting-tag'), { target: { value: '   ' } });
        expect(screen.getByTestId('kb-meeting-submit').disabled).toBe(true);
        expect(onCreate).not.toHaveBeenCalled();
    });

    it('surfaces the server`s refusal rather than closing as if it worked', async () => {
        const onCreate = vi.fn().mockRejectedValue(
            Object.assign(new Error('No meetings you can open carry that tag.'), { status: 400, code: 'tag_not_visible' }),
        );
        render(<AddSourcePanel canManage onCreate={onCreate} />);
        fireEvent.click(screen.getByTestId('kb-add-kind-meeting_tag'));
        fireEvent.change(await screen.findByTestId('kb-meeting-tag'), { target: { value: 'directie' } });
        fireEvent.click(screen.getByTestId('kb-meeting-submit'));
        expect(await screen.findByText(/No meetings you can open carry that tag/)).toBeTruthy();
        expect(screen.getByTestId('kb-form-meeting_tag')).toBeTruthy();
    });
});

// As the LIST route really answers: names, counts and grades — never the
// columns. Those come from the schema route, per table, when it is picked.
// (The list used to be mocked WITH fields here, which is how a form whose
// button could never enable passed every test.) Module-scoped, not inside
// `describe('DatatableForm', …)`, so the schema-route tests below — a
// separate describe, to keep either arrow function under the line cap — can
// share them too.
const DATATABLE_TABLES = [{ id: 'dt1', name: 'Prices', rowCount: 212 }];
const DATATABLE_SCHEMA = { fields: [{ key: 'name' }, { key: 'price' }, { key: 'id' }, { key: 'updated_by' }], modelVersion: 3 };

async function openDatatableForm(list = DATATABLE_TABLES, schema = DATATABLE_SCHEMA) {
    const { datatablesApi } = await import('../Datatables/datatablesApi');
    datatablesApi.list.mockResolvedValue(list);
    datatablesApi.getSchema.mockResolvedValue(schema);
    const onCreate = vi.fn().mockResolvedValue({});
    render(<AddSourcePanel canManage onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('kb-add-kind-datatable'));
    await screen.findByTestId('kb-form-datatable');
    return { onCreate, datatablesApi };
}

/** Pick the table and wait for its columns to arrive. */
async function pickDatatableColumn(id = 'dt1') {
    fireEvent.change(screen.getByTestId('kb-datatable-select'), { target: { value: id } });
    await screen.findByTestId('kb-datatable-column-name');
}

/**
 * The datatable form (K8).
 *
 * A row becomes a document of "column: value" lines, so WHICH columns are in
 * it decides whether the document answers anything — a price list needs the
 * name and the price, not `imported_batch_id`, and every extra column dilutes
 * the ones that matter for retrieval.
 *
 * And this source reads the table as the knowledge base's OWNER, so rows the
 * owner may read become searchable by everyone the base is shared with. The
 * table's row rules protect the owner's view, not the reader's. That is said
 * on the form rather than discovered afterwards.
 */
describe('DatatableForm', () => {
    it('creates a source from a table and its columns', async () => {
        const { onCreate } = await openDatatableForm();
        await pickDatatableColumn();
        fireEvent.click(screen.getByTestId('kb-datatable-submit'));
        await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
            kind: 'datatable',
            config: { datatableId: 'dt1', columns: ['name', 'price'], titleColumn: 'name' },
        }));
    });

    it('never offers a column the platform maintains', async () => {
        // Nobody wrote `updated_by`, and nobody wants it read back to them in
        // an answer.
        await openDatatableForm();
        await pickDatatableColumn();
        expect(screen.getByTestId('kb-datatable-column-name')).toBeTruthy();
        expect(screen.queryByTestId('kb-datatable-column-id')).toBeNull();
        expect(screen.queryByTestId('kb-datatable-column-updated_by')).toBeNull();
    });

    it('starts with every column ticked, so a wide table looks wrong on purpose', async () => {
        await openDatatableForm();
        await pickDatatableColumn();
        expect(screen.getByTestId('kb-datatable-column-name').dataset.active).toBe('true');
        expect(screen.getByTestId('kb-datatable-column-price').dataset.active).toBe('true');
    });

    it('lets a column be left out, and says why that matters', async () => {
        const { onCreate } = await openDatatableForm();
        await pickDatatableColumn();
        fireEvent.click(screen.getByTestId('kb-datatable-column-price'));
        expect(screen.getByText(/dilutes the ones that answer questions/i)).toBeTruthy();
        fireEvent.click(screen.getByTestId('kb-datatable-submit'));
        await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
            config: expect.objectContaining({ columns: ['name'] }),
        })));
    });

    it('says who will be able to read the rows', async () => {
        await openDatatableForm();
        expect(screen.getByText(/row permissions do not follow them here/i)).toBeTruthy();
    });

    it('will not submit without a table, or with no columns left', async () => {
        await openDatatableForm();
        expect(screen.getByTestId('kb-datatable-submit').disabled).toBe(true);
        await pickDatatableColumn();
        expect(screen.getByTestId('kb-datatable-submit').disabled).toBe(false);
        fireEvent.click(screen.getByTestId('kb-datatable-column-name'));
        fireEvent.click(screen.getByTestId('kb-datatable-column-price'));
        expect(screen.getByTestId('kb-datatable-submit').disabled).toBe(true);
    });

    it('a table list that will not load says so, rather than showing an empty picker', async () => {
        const { datatablesApi } = await import('../Datatables/datatablesApi');
        datatablesApi.list.mockRejectedValue(new Error('down'));
        render(<AddSourcePanel canManage onCreate={vi.fn()} />);
        fireEvent.click(screen.getByTestId('kb-add-kind-datatable'));
        expect(await screen.findByText(/Could not load your tables/i)).toBeTruthy();
    });
});

describe('DatatableForm — the schema route', () => {
    it('reads the columns from there, because the list never carries them', async () => {
        const { datatablesApi } = await openDatatableForm();
        expect(datatablesApi.getSchema).not.toHaveBeenCalled();
        fireEvent.change(screen.getByTestId('kb-datatable-select'), { target: { value: 'dt1' } });
        expect(screen.getByTestId('kb-datatable-columns-loading')).toBeTruthy();
        expect(screen.getByTestId('kb-datatable-submit').disabled).toBe(true);
        await screen.findByTestId('kb-datatable-column-name');
        expect(datatablesApi.getSchema).toHaveBeenCalledWith('dt1');
        expect(screen.queryByTestId('kb-datatable-columns-loading')).toBeNull();
    });

    it('a schema that will not load says so, and the button stays off', async () => {
        const { datatablesApi } = await openDatatableForm();
        datatablesApi.getSchema.mockRejectedValue(new Error('down'));
        fireEvent.change(screen.getByTestId('kb-datatable-select'), { target: { value: 'dt1' } });
        expect(await screen.findByText(/Could not read this table/i)).toBeTruthy();
        expect(screen.getByTestId('kb-datatable-submit').disabled).toBe(true);
    });
});

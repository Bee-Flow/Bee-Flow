import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DatatableDetail from './DatatableDetail';
import { datatablesApi } from './datatablesApi';
import { DEFINITION_MANAGED_KINDS, isFormAnswers, isSchemaLocked, managedColumnProblem, tableIconOf } from './datatableDisplay';

/**
 * A FORM'S ANSWERS table in the detail view: opens on its Dashboard tab,
 * keeps its Retention tab (answers may age), links to the form, locks its
 * columns with per-question hints, lets the owner drop a retired question's
 * column and nothing else, and says what deleting it means.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), get: vi.fn(), remove: vi.fn(), update: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(),
        listRows: vi.fn(), addRow: vi.fn(), updateRow: vi.fn(), deleteRow: vi.fn(), exportCsv: vi.fn(),
        listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(), setSharing: vi.fn(),
        listUsage: vi.fn(), health: vi.fn(), repair: vi.fn(),
        answersSummary: vi.fn(), aggregate: vi.fn(), removeAnswersColumn: vi.fn(), releaseAnswers: vi.fn(), getRow: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});
vi.mock('../Forms/answers/AnswersDashboard', () => ({
    default: ({ datatableId, automationId }) => <div data-testid="dash-stub" data-table={datatableId} data-form={automationId || ''} />,
}));

const FIELDS = [
    { id: 'fld_faxrunid', key: 'run_id', name: 'Run', type: 'text' },
    { id: 'fld_faxcompl', key: 'completed_at', name: 'Completed', type: 'datetime' },
    { id: 'fld_fa1txt', key: 'email', name: 'Your e-mail', type: 'text' },
    { id: 'fld_fa2sel', key: 'source', name: 'How did you hear about us?', type: 'select', options: ['search'] },
    { id: 'fld_fa3bol', key: 'subscribe', name: 'Subscribe to updates?', type: 'bool' },
];
const SOURCE = {
    kind: 'form_answers', automationId: 'au1', linked: true, linkedAt: '2026-09-13T10:00:00Z', lastWriteError: null,
    columns: [
        { fieldId: 'fld_fa1txt', key: 'email', name: 'Your e-mail', formName: 'email', pageStepId: null, formType: 'email', columnType: 'text', required: true, retired: false },
        { fieldId: 'fld_fa2sel', key: 'source', name: 'How did you hear about us?', formName: 'source', pageStepId: null, formType: 'select', columnType: 'select', required: false, retired: false },
        { fieldId: 'fld_fa3bol', key: 'subscribe', name: 'Subscribe to updates?', formName: 'subscribe', pageStepId: null, formType: 'checkbox', columnType: 'bool', required: false, retired: true },
    ],
};
const TABLE = {
    id: 'tbl_a', name: 'Answers — Customer feedback', key: 'customer_feedback_answers', description: 'Answers people gave on a form.',
    rowCount: 12, isPublished: false, sharedGroups: [], writeMode: 'grants',
    scopeKind: 'org', managedKind: 'form_answers', grade: 'owner',
    retentionDays: null, retentionField: 'created_at', source: SOURCE, sync: null,
};

function renderDetail(table = TABLE, props = {}) {
    return render(<DatatableDetail table={table} canManage currentUserId="u1" onBack={() => {}} onChanged={() => {}} onDeleted={() => {}} onNavigate={vi.fn()} {...props} />);
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.get.mockResolvedValue({ datatable: TABLE });
    datatablesApi.getSchema.mockResolvedValue({ fields: FIELDS, modelVersion: 3 });
    datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0 });
    datatablesApi.listUsage.mockResolvedValue({ usage: [] });
    datatablesApi.listGrants.mockResolvedValue({ grants: [] });
    datatablesApi.removeAnswersColumn.mockResolvedValue({ fields: FIELDS.slice(0, 4), modelVersion: 4, source: SOURCE });
});

describe('the vocabulary', () => {
    it('form_answers is definition-owned: schema-locked, refused as a whole, its own icon', () => {
        expect(DEFINITION_MANAGED_KINDS).toContain('form_answers');
        expect(isSchemaLocked('form_answers')).toBe(true);
        expect(isFormAnswers(TABLE)).toBe(true);
        expect(managedColumnProblem('form_answers', FIELDS)).toEqual({ reason: 'definition_owned' });
        expect(tableIconOf(TABLE)).toBe('form');
    });
});

describe('<DatatableDetail> for a form-answers table', () => {
    it('opens on the Dashboard tab, keeps Retention, and links to the form', async () => {
        const onNavigate = vi.fn();
        renderDetail(TABLE, { onNavigate });
        const dash = await screen.findByTestId('dash-stub');
        expect(dash.getAttribute('data-form')).toBe('au1');
        const tabs = screen.getAllByRole('radio', { name: /Dashboard|Columns|Rows|Retention|Data|Sharing|Used by|Nextcloud|Spreadsheet/ }).map(el => el.textContent);
        expect(tabs[0]).toContain('Dashboard');
        expect(tabs.some(x => /Retention|Data/.test(x))).toBe(true);
        fireEvent.click(screen.getByTestId('open-form'));
        expect(onNavigate).toHaveBeenCalledWith('studio/forms/au1');
    });

    it('honours the tab the URL asked for', async () => {
        renderDetail(TABLE, { initialTab: 'rows' });
        await waitFor(() => expect(screen.getByRole('radio', { name: /Rows/ }).getAttribute('aria-checked')).toBe('true'));
    });

    it('Columns: locked with per-question hints; only the retired column can be removed, after a confirm', async () => {
        renderDetail();
        await screen.findByTestId('dash-stub');
        fireEvent.click(screen.getByRole('radio', { name: /Columns/ }));
        expect(await screen.findByText(/These columns are the questions on the form/)).toBeTruthy();
        expect(screen.getByText(/from the form · Your e-mail/)).toBeTruthy();
        expect(screen.getByText(/no longer on the form · Subscribe to updates\?/)).toBeTruthy();
        expect(screen.getByText(/fixed · the run the submission started/)).toBeTruthy();
        expect(screen.queryByText('Add a column')).toBeNull();
        expect(screen.queryByRole('button', { name: /Save columns/ })).toBeNull();
        const removes = screen.getAllByTestId('remove-retired');
        expect(removes.length).toBe(1);
        fireEvent.click(removes[0]);
        expect(await screen.findByText('Remove the column “Subscribe to updates?”?')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Remove the column' }));
        await waitFor(() => expect(datatablesApi.removeAnswersColumn).toHaveBeenCalledWith('tbl_a', 'fld_fa3bol', { confirmBreaking: true }));
        expect(datatablesApi.putSchema).not.toHaveBeenCalled();
    });

    it('a viewer sees the hints but no remove button', async () => {
        renderDetail({ ...TABLE, grade: 'viewer' });
        await screen.findByTestId('dash-stub');
        fireEvent.click(screen.getByRole('radio', { name: /Columns/ }));
        expect(await screen.findByText(/no longer on the form · Subscribe to updates\?/)).toBeTruthy();
        expect(screen.queryByTestId('remove-retired')).toBeNull();
    });

    it('the danger zone says the form stays and stops collecting', async () => {
        renderDetail();
        await screen.findByTestId('dash-stub');
        fireEvent.click(screen.getByRole('button', { name: /More about this table/ }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Delete this table/ }));
        expect(await screen.findByText(/the form stays and stops collecting/)).toBeTruthy();
    });
});

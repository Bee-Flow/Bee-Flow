import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FormPage from './FormPage';

/**
 * The Form page: the owner gets four tabs and saves through PUT /:id with the
 * whole definition; a colleague the answers table is shared with gets only
 * Answers and no rename; the token is never in a navigation call; unsaved
 * questions ask before a tab switch; Settings' collect toggle saves
 * `collect` on the trigger form.
 */

const { api } = vi.hoisted(() => ({
    api: {
        getForm: vi.fn(), updateAutomation: vi.fn(), activate: vi.fn(), deactivate: vi.fn(),
        deleteAutomation: vi.fn(), provisionAnswersTable: vi.fn(),
        listFormPages: vi.fn(), createFormPage: vi.fn(), rotateFormPage: vi.fn(),
    },
}));
vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => api }));
vi.mock('./answers/AnswersDashboard', () => ({
    default: ({ datatableId, grade, mine }) => <div data-testid="dash-stub" data-table={datatableId} data-grade={grade || ''} data-mine={String(!!mine)} />,
}));
vi.mock('../../../automation/Builder/flow/settings/FormBuilderFields', () => ({
    default: ({ form, onChange }) => (
        <div data-testid="builder-stub">
            <input aria-label="Title" value={form.title || ''} onChange={(e) => onChange({ ...form, title: e.target.value })} />
        </div>
    ),
}));
vi.mock('../Datatables/datatablesApi', () => ({
    datatablesApi: { get: vi.fn().mockResolvedValue({ datatable: { id: 'tbl_a', name: 'Answers', grade: 'owner', scopeKind: 'org', isPublished: false, sharedGroups: [], writeMode: 'grants' } }), listGrants: vi.fn().mockResolvedValue({ grants: [] }) },
}));
vi.mock('../Datatables/DatatableSharing', () => ({ default: () => <div data-testid="sharing-stub" /> }));
vi.mock('../AppStudio/rbac/useAppRoles', () => ({ useOrgDirectory: () => ({ users: [{ id: 'u-pat', name: 'Pat Jansen' }], groups: [{ id: 'g-fin', name: 'Finance' }] }) }));

const TOKEN = 'a'.repeat(48);
const DEFINITION = {
    schemaVersion: 1,
    trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { title: 'Customer feedback', collect: true, fields: [{ name: 'q1', type: 'text', label: 'Q1' }] } },
    steps: [], edges: [], vars: {},
};
const row = (over = {}) => ({
    id: TOKEN, url: `/f/${TOKEN}`, automationId: 'au1', triggerStepId: null, title: 'Customer feedback', live: true,
    submissions: 5, lastSeenAt: null, createdAt: '2026-09-01T00:00:00Z', mine: true,
    answers: { collecting: true, datatableId: 'tbl_a', grade: 'owner', rowCount: 5, linked: true, lastWriteError: null },
    ...over,
});
const detail = (over = {}) => ({
    ...row(), isActive: true, isDraft: false,
    questions: { title: 'Customer feedback', description: '', submitLabel: '', successMessage: '', collect: true, fields: [{ name: 'q1', type: 'text', label: 'Q1' }], theme: null },
    pages: [], definition: DEFINITION, routineTitle: 'Feedback',
    ...over,
});

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    api.getForm.mockResolvedValue({ form: detail() });
    api.updateAutomation.mockResolvedValue({ automation: { id: 'au1' }, answers: { datatableId: 'tbl_a' } });
});

const renderPage = (props = {}) => render(<FormPage form={row()} onBack={vi.fn()} onNavigate={vi.fn()} onTab={vi.fn()} {...props} />);

describe('<FormPage>', () => {
    it('the owner gets Questions · Share · Answers · Settings, opens on Questions and can rename', async () => {
        const onNavigate = vi.fn();
        renderPage({ onNavigate });
        await screen.findByTestId('builder-stub');
        const tabs = screen.getAllByRole('tab').map(el => el.textContent);
        expect(tabs.join('|')).toMatch(/Questions.*Share.*Answers.*Settings/);
        expect(api.getForm).toHaveBeenCalledWith('au1');
        fireEvent.click(screen.getByTestId('form-page-open-routine'));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/au1');
        for (const [target] of onNavigate.mock.calls) expect(target).not.toContain(TOKEN);
    });

    it('saving the questions PUTs the WHOLE definition with the edited trigger form', async () => {
        renderPage();
        await screen.findByTestId('builder-stub');
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Feedback 2026' } });
        fireEvent.click(screen.getByTestId('form-save'));
        await waitFor(() => expect(api.updateAutomation).toHaveBeenCalled());
        const [id, body] = api.updateAutomation.mock.calls[0];
        expect(id).toBe('au1');
        expect(body.definition.trigger.form.title).toBe('Feedback 2026');
        expect(body.definition.trigger.form.collect).toBe(true);
        expect(body.definition.steps).toEqual([]);
    });

    it('unsaved questions ask before a tab switch, and "Keep editing" stays', async () => {
        renderPage();
        await screen.findByTestId('builder-stub');
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed' } });
        fireEvent.click(screen.getByRole('tab', { name: /Share/ }));
        expect(await screen.findByText('Unsaved changes')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        expect(screen.getByTestId('builder-stub')).toBeTruthy();
    });

    it('a colleague with a viewer grade gets only Answers, no rename, no routine button', async () => {
        api.getForm.mockResolvedValue({ form: detail({ mine: false, definition: undefined, answers: { collecting: true, datatableId: 'tbl_a', grade: 'viewer', rowCount: 5 } }) });
        renderPage({ form: row({ mine: false, answers: { collecting: true, datatableId: 'tbl_a', grade: 'viewer', rowCount: 5 } }) });
        const dash = await screen.findByTestId('dash-stub');
        expect(dash.getAttribute('data-grade')).toBe('viewer');
        expect(dash.getAttribute('data-mine')).toBe('false');
        expect(screen.getAllByRole('tab').length).toBe(1);
        expect(screen.queryByTestId('form-page-open-routine')).toBeNull();
        expect(screen.queryByTestId('builder-stub')).toBeNull();
    });

    it('Settings: the collect toggle saves `collect` on the trigger form; switching off asks first', async () => {
        renderPage({ tab: 'settings' });
        await screen.findByTestId('form-settings');
        fireEvent.click(document.getElementById('form-collect'));
        expect(await screen.findByText('Stop collecting?')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Stop collecting' }));
        await waitFor(() => expect(api.updateAutomation).toHaveBeenCalled());
        expect(api.updateAutomation.mock.calls[0][1].definition.trigger.form.collect).toBe(false);
    });

    it('Share: who can fill it in sits between the link and the answers sharing, and the link sentence follows it', async () => {
        api.getForm.mockResolvedValue({ form: detail({ audience: { mode: 'restricted', groups: ['g-fin'], users: [] } }) });
        renderPage({ tab: 'share' });
        const card = await screen.findByTestId('form-audience');
        expect(card.textContent).toContain('Finance');
        expect(screen.getByText(/Only the people and groups listed under/)).toBeTruthy();
        // order on the page: link, audience, answers
        const ids = [...document.querySelectorAll('[data-testid]')].map(el => el.getAttribute('data-testid'));
        expect(ids.indexOf('form-link-card')).toBeLessThan(ids.indexOf('form-audience'));
        expect(ids.indexOf('form-audience')).toBeLessThan(ids.indexOf('form-answers-sharing'));
    });

    it('Answers with no table says so instead of a blank', async () => {
        api.getForm.mockResolvedValue({ form: detail({ answers: null, questions: { title: 'x', collect: false, fields: [] } }) });
        renderPage({ form: row({ answers: null }), tab: 'answers' });
        expect(await screen.findByTestId('form-answers-none')).toBeTruthy();
    });
});

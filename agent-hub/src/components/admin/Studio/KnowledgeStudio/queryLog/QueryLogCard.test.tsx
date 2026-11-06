import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import QueryLogCard from './QueryLogCard';
import { renderWithClient } from '@/test/render';
import { asMock, partial, stub } from '@/test/mocks';
import LicenseContext from '@/components/licensing/LicenseContext';
import type { ComponentProps, ReactElement } from 'react';
import type { KnowledgeBase } from '../knowledgeApi';

const fetchMock = vi.fn();
const rel = (u: unknown) => String(u).replace(/^https?:\/\/[^/]+/, '');

let licensed = true;
const license = () => stub<ComponentProps<typeof LicenseContext.Provider>['value']>({ hasFeature: (f: string) => licensed && f === 'kb_query_log' });
const renderCard = (ui: ReactElement) => renderWithClient(<LicenseContext.Provider value={license()}>{ui}</LicenseContext.Provider>);

const kb = (over: object = {}) => partial<KnowledgeBase>({ id: 'kb1', name: 'Handbook', queryLogEnabled: false, queryLogRetentionDays: 90, ...over });
const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function calls() {
    return asMock(fetchMock).mock.calls
        .map(([url, init]) => ({ url: rel(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : null }))
        .filter((c) => c.url !== '/api/kb/query-log/dpias');
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    licensed = true;
    asMock(fetchMock).mockImplementation(async (url: string) => (rel(url) === '/api/kb/query-log/dpias'
        ? reply({ dpias: [{ id: '7', title: 'Chat monitoring', status: 'current' }] })
        : reply({ enabled: true, retentionDays: 90, deleted: 0 })));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('QueryLogCard', () => {
    it('is not drawn for somebody who cannot manage the base', () => {
        renderCard(<QueryLogCard kb={kb()} canManage={false} />);
        expect(screen.queryByTestId('kb-query-log-card')).toBeNull();
    });

    it('is locked with an Enterprise label without the licence, and has no switch', () => {
        licensed = false;
        renderCard(<QueryLogCard kb={kb()} canManage />);
        expect(screen.getByTestId('kb-query-log-enterprise').textContent).toContain('Enterprise');
        expect(screen.queryByTestId('kb-query-log-toggle')).toBeNull();
    });

    it('shows the privacy text and the legal basis, and blocks enabling until every attestation field is filled', async () => {
        const user = userEvent.setup();
        renderCard(<QueryLogCard kb={kb()} canManage />);
        await user.click(screen.getByTestId('kb-query-log-toggle'));
        const text = screen.getByTestId('kb-query-log-privacy').textContent ?? '';
        expect(text).toMatch(/not zero-knowledge/);
        expect(text).toMatch(/managers/);
        expect(screen.getByTestId('kql-enable-basis').textContent).toMatch(/legitimate interest.*WOR art\. 27.*DPIA/s);
        expect(screen.getByTestId('kql-enable-basis').textContent).not.toMatch(/consent of/i);
        const submit = screen.getByTestId('kql-enable-submit') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        await user.click(screen.getByTestId('kql-enable-purpose'));
        await user.selectOptions(screen.getByTestId('kql-enable-dpia'), 'not_required');
        await user.selectOptions(screen.getByTestId('kql-enable-council'), 'not_applicable');
        expect(submit.disabled).toBe(true); // a reason is still missing
        await user.selectOptions(screen.getByTestId('kql-enable-reason'), 'no_works_council');
        expect(submit.disabled).toBe(true); // the privacy notice is still unconfirmed
        await user.click(screen.getByTestId('kql-enable-notice'));
        expect(submit.disabled).toBe(false);
        expect(calls()).toHaveLength(0);
    });

    it('sends the attestation, the names choice and the retention when enabling', async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        renderCard(<QueryLogCard kb={kb()} canManage onSaved={onSaved} />);
        await user.click(screen.getByTestId('kb-query-log-toggle'));
        await user.click(screen.getByTestId('kql-enable-purpose'));
        await user.selectOptions(screen.getByTestId('kql-enable-dpia'), 'done');
        await user.selectOptions(await screen.findByTestId('kql-enable-dpia-id'), '7');
        await user.selectOptions(screen.getByTestId('kql-enable-council'), 'consent');
        await user.click(screen.getByTestId('kql-enable-notice'));
        await user.click(screen.getByTestId('kql-enable-names'));
        await user.click(screen.getByTestId('kql-enable-submit'));
        await waitFor(() => expect(calls().filter((c) => c.method === 'PUT')).toEqual([{
            url: '/api/kb/kb1/query-log/settings', method: 'PUT',
            body: {
                enabled: true, retentionDays: 90, showNames: true, aiActHighRisk: false,
                attestation: { purpose: 'ai_quality', dpia: 'done', dpiaId: '7', worksCouncil: 'consent', privacyNoticeUpdated: true },
            },
        }]));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    it('limits the term to 180 or 365 days once the base is high-risk, in the form and on a base that logs', async () => {
        const user = userEvent.setup();
        const first = renderCard(<QueryLogCard kb={kb()} canManage />);
        await user.click(screen.getByTestId('kb-query-log-toggle'));
        const terms = () => within(screen.getByTestId('kql-enable-retention')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
        expect(terms()).toEqual(['30', '90', '180', '365']);
        await user.click(screen.getByTestId('kql-enable-high-risk'));
        expect(terms()).toEqual(['180', '365']);
        first.unmount();

        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true, queryLogAiActHighRisk: true, queryLogRetentionDays: 180 })} canManage />);
        const options = within(screen.getByTestId('kb-query-log-retention')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
        expect(options).toEqual(['180', '365']);
    });

    it('turns names and the high-risk flag on for a base that logs, lifting a short term to 180 days', async () => {
        const user = userEvent.setup();
        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true })} canManage />);
        await user.click(screen.getByTestId('kb-query-log-show-names'));
        await waitFor(() => expect(calls()[0].body).toEqual({ enabled: true, retentionDays: 90, showNames: true }));
        await user.click(screen.getByTestId('kb-query-log-high-risk'));
        await waitFor(() => expect(calls()[1].body).toEqual({ enabled: true, retentionDays: 180, aiActHighRisk: true }));
    });

    it('shows the stored attestation read-only on a base that logs', () => {
        const attestation = { purpose: 'ai_quality' as const, dpia: 'not_required' as const, worksCouncil: 'not_applicable', worksCouncilReason: 'no_works_council', privacyNoticeUpdated: true };
        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true, queryLogAttestation: attestation })} canManage />);
        const view = screen.getByTestId('kb-query-log-attestation').textContent ?? '';
        expect(view).toContain('A DPIA is not required');
        expect(view).toContain('We have no works council');
        expect(view).toContain('Updated');
    });

    it('sends the new term when the retention changes on a base that logs', async () => {
        const user = userEvent.setup();
        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true })} canManage />);
        await user.selectOptions(screen.getByTestId('kb-query-log-retention'), '180');
        await waitFor(() => expect(calls()[0].body).toEqual({ enabled: true, retentionDays: 180 }));
    });

    it('offers keep or delete when switching off, and keeps by default', async () => {
        const user = userEvent.setup();
        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true })} canManage />);
        await user.click(screen.getByTestId('kb-query-log-toggle'));
        expect(screen.getByTestId('kb-query-log-disable-choice')).toBeTruthy();
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(calls()[0].body).toEqual({ enabled: false, retentionDays: 90, deleteExisting: false }));
    });

    it('deletes the entries when that option is chosen', async () => {
        const user = userEvent.setup();
        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true })} canManage />);
        await user.click(screen.getByTestId('kb-query-log-toggle'));
        await user.click(screen.getByRole('radio', { name: /Delete all entries now/ }));
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(calls()).toEqual([{ url: '/api/kb/kb1/query-log', method: 'DELETE', body: null }]));
    });

    it('still lets a manager switch off and purge after the licence lapsed', async () => {
        licensed = false;
        const user = userEvent.setup();
        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true })} canManage />);
        expect(screen.queryByTestId('kb-query-log-toggle')).toBeNull();
        await user.click(screen.getByTestId('kb-query-log-purge'));
        expect(screen.queryByTestId('kb-query-log-disable-choice')).toBeNull();
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(calls()).toEqual([{ url: '/api/kb/kb1/query-log', method: 'DELETE', body: null }]));
    });

    it('offers no purge without the licence when nothing is logged', () => {
        licensed = false;
        renderCard(<QueryLogCard kb={kb()} canManage />);
        expect(screen.queryByTestId('kb-query-log-purge')).toBeNull();
    });
    it('says logging is paused for a base switched on without an attestation, and opens the form to complete it', async () => {
        const user = userEvent.setup();
        renderCard(<QueryLogCard kb={kb({ queryLogEnabled: true, queryLogAttestation: null })} canManage />);
        expect(screen.getByTestId('kb-query-log-paused').textContent).toMatch(/paused/);
        await user.click(screen.getByTestId('kb-query-log-complete-attestation'));
        expect(screen.getByTestId('kql-enable-form')).toBeTruthy();
    });
});

import { screen, waitFor } from '@testing-library/react';
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
    return asMock(fetchMock).mock.calls.map(([url, init]) => ({ url: rel(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : null }));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    licensed = true;
    asMock(fetchMock).mockResolvedValue(reply({ enabled: true, retentionDays: 90, deleted: 0 }));
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

    it('asks with the privacy text first, then enables with the chosen retention', async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        renderCard(<QueryLogCard kb={kb()} canManage onSaved={onSaved} />);
        await user.click(screen.getByTestId('kb-query-log-toggle'));
        expect(calls()).toHaveLength(0);
        const text = screen.getByTestId('kb-query-log-privacy').textContent ?? '';
        expect(text).toMatch(/not zero-knowledge/);
        expect(text).toMatch(/managers/);
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(calls()).toEqual([{ url: '/api/kb/kb1/query-log/settings', method: 'PUT', body: { enabled: true, retentionDays: 90 } }]));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
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
});

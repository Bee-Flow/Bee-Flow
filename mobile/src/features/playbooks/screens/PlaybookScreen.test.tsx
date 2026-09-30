/**
 * One playbook against canned answers, face by face: a server phase that is
 * ready starts itself, a landed phase is continued with the brief the person
 * edited, a failure is retried, a builder phase is marked done without the
 * phone ever starting a builder, access is proposed and approved, the review
 * is registered, and a stopped playbook resumes — each press sending exactly
 * the web's wire.
 */

import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { PlaybookScreen } from './PlaybookScreen';

jest.setTimeout(30_000);

/* eslint-disable @typescript-eslint/no-require-imports -- a jest.mock factory loads the shared mocks lazily */
jest.mock('expo-router', () => require('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => require('@/shared/testing/screenMocks').apiClient());
jest.mock('@/shared/markdown', () => ({ Markdown: () => null }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;

const ph = (key: string, status: string, over: Record<string, unknown> = {}) => ({ key, kind: key, status, attempt: 0, artifacts: {}, ...over });
const pb = (phases: unknown[], over: Record<string, unknown> = {}) => ({ id: 'pb_1', title: 'Contracts', status: 'active', version: 3, options: {}, phases, ...over });

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });

async function open(playbook: unknown, extra: (path: string) => unknown = () => null) {
    get.mockImplementation((path: string) => Promise.resolve(path === '/api/playbooks/pb_1' ? { playbook } : extra(path)));
    post.mockResolvedValue({ playbook });
    patch.mockResolvedValue({ playbook });
    await renderWithProviders(
        <ConfirmProvider>
            <PlaybookScreen id="pb_1" />
        </ConfirmProvider>,
        { queryClient: client() },
    );
    await screen.findAllByText('Contracts');
}

beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
});

describe('PlaybookScreen', () => {
    it('starts a ready server phase by itself, once', async () => {
        await open(pb([ph('table', 'ready'), ph('routine', 'pending')]));
        expect(await screen.findByTestId('playbook-stage-table')).toBeTruthy();
        const runs = post.mock.calls.filter((c) => c[0] === '/api/playbooks/pb_1/phases/table/run');
        expect(runs).toHaveLength(1);
    });

    it('continues a landed phase with the brief the person edited', async () => {
        await open(pb([
            ph('table', 'awaiting', { summary: 'Table ready', artifacts: { datatableName: 'Contracts', rowCount: 0, fields: [{ key: 'supplier', name: 'Supplier', type: 'text' }] } }),
            ph('routine', 'ready', { brief: '# Build the routine' }),
        ]));
        expect(await screen.findByText('Phase 1 of 2 landed — Table')).toBeTruthy();
        expect(screen.getByText('Supplier')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('playbook-brief-edit'));
        await fireEvent.changeText(screen.getByTestId('playbook-next-brief'), '# Build it my way');
        await fireEvent.press(screen.getByTestId('playbook-continue'));
        expect(patch).toHaveBeenCalledWith(
            '/api/playbooks/pb_1',
            { expectedVersion: 3, phases: [{ key: 'table', status: 'done' }, { key: 'routine', brief: '# Build it my way' }] },
            { retry: false },
        );
    });

    it('retries a failed phase', async () => {
        await open(pb([ph('table', 'done'), ph('routine', 'done'), ph('fill', 'failed', { error: 'artifacts_missing' })]));
        expect(await screen.findByText('The previous phase produced nothing this one can build on.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('playbook-retry'));
        expect(post.mock.calls.map((c) => c.slice(0, 2))).toContainEqual(['/api/playbooks/pb_1/phases/fill/retry', { expectedVersion: 3 }]);
    });

    it('never starts a builder, and marks one done once its automation exists', async () => {
        await open(pb([ph('table', 'done'), ph('routine', 'running', { artifacts: { automationId: 'a1' } })]));
        expect(await screen.findByText('This phase is being built on a computer')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('playbook-mark-done'));
        expect(patch).toHaveBeenCalledWith(
            '/api/playbooks/pb_1',
            { expectedVersion: 3, phases: [{ key: 'routine', status: 'awaiting', artifacts: { automationId: 'a1' } }] },
            { retry: false },
        );
        expect(post.mock.calls.filter((c) => String(c[0]).includes('/phases/routine/'))).toEqual([]);
    });

    it('says a ready builder phase is built on a computer, opens no web page, and skips it here', async () => {
        await open(pb([ph('table', 'done'), ph('routine', 'ready', { brief: '# Build the routine' })]));
        expect(await screen.findByText(/The AI builder builds this phase on a computer/)).toBeTruthy();
        expect(screen.queryByText('Continue on the web')).toBeNull();
        await fireEvent.press(screen.getByTestId('playbook-builder-skip'));
        expect(post.mock.calls.map((c) => c.slice(0, 2))).toContainEqual(['/api/playbooks/pb_1/phases/routine/skip', { expectedVersion: 3 }]);
        expect(patch.mock.calls.filter((c) => JSON.stringify(c[1]).includes('running'))).toEqual([]);
    });

    it('offers no web page in the overflow menu', async () => {
        await open(pb([ph('table', 'done'), ph('routine', 'ready')]));
        await fireEvent.press(screen.getByLabelText('More'));
        expect(await screen.findByText('Delete')).toBeTruthy();
        expect(screen.queryByText('Open on the web')).toBeNull();
    });

    it('holds a plan that creates roles for a computer, without a web page', async () => {
        const access = pb([ph('table', 'done'), ph('app', 'done', { artifacts: { appId: 'app1' } }), ph('access', 'running', { artifacts: { appId: 'app1' } })]);
        await open(access, (path) => (path.endsWith('/members') ? { members: [] } : { app: { id: 'app1', name: 'Tracker', isPublished: false, sharedGroups: [] } }));
        post.mockImplementation((path: string) => Promise.resolve(path.endsWith('/access-plan')
            ? { plan: { audience: { kind: 'organisation' }, members: [], roles: [{ key: 'reviewer', label: 'Reviewer' }], tableRules: [], byGroup: {}, empty: false } }
            : { playbook: access }));
        await fireEvent.changeText(await screen.findByTestId('playbook-access-say'), 'Reviewers may only read');
        await fireEvent.press(screen.getByTestId('playbook-access-ask'));
        expect(await screen.findByText(/changed in App Studio on a computer/)).toBeTruthy();
        expect(screen.queryByText('Continue on the web')).toBeNull();
        await fireEvent.press(screen.getByTestId('playbook-access-approve'));
        expect(patch.mock.calls.filter((c) => String(c[0]).startsWith('/api/studio-apps/'))).toEqual([]);
    });

    it('proposes access from a sentence and approves it', async () => {
        const access = pb([ph('table', 'done'), ph('app', 'done', { artifacts: { appId: 'app1' } }), ph('access', 'running', { artifacts: { appId: 'app1' } })]);
        await open(access, (path) => (path.endsWith('/members') ? { members: [] } : { app: { id: 'app1', name: 'Tracker', isPublished: false, sharedGroups: [] } }));
        post.mockImplementation((path: string) => Promise.resolve(path.endsWith('/access-plan')
            ? { plan: { audience: { kind: 'organisation' }, members: [], roles: [], tableRules: [], byGroup: {}, empty: false } }
            : { playbook: access }));
        patch.mockResolvedValue({ playbook: access });
        expect(await screen.findByText('Who uses "Tracker"?')).toBeTruthy();
        await fireEvent.changeText(screen.getByTestId('playbook-access-say'), 'Everyone may use it');
        await fireEvent.press(screen.getByTestId('playbook-access-ask'));
        expect(await screen.findByText('• Publish it to everyone in the organisation.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('playbook-access-approve'));
        await screen.findByText('• Publish it to everyone in the organisation.');
        expect(patch).toHaveBeenCalledWith('/api/studio-apps/app1/publish', { isPublished: true, sharedGroups: [] }, { retry: false });
        expect(patch).toHaveBeenCalledWith(
            '/api/playbooks/pb_1',
            { expectedVersion: 3, phases: [{ key: 'access', status: 'awaiting', summary: 'Shared with the whole organisation.', artifacts: { appId: 'app1', accessApplied: true, nextcloudMenu: false } }] },
            { retry: false },
        );
    });

    it('registers the review with the findings kept', async () => {
        await open(pb([
            ph('table', 'done'),
            ph('compliance', 'awaiting', {
                artifacts: {
                    frameworks: ['GDPR'],
                    checks: { ran: 4, clean: 3 },
                    findings: [{ code: 'ropa_retention', severity: 'high', title: 'No retention period', why: 'Rows stay for ever.' }],
                    facts: { table: { name: 'Contracts', columns: [{ key: 'signed', name: 'Signed', type: 'date' }], personal: [] }, org: {} },
                },
            }),
        ]));
        expect(await screen.findByText('1 thing to tidy up')).toBeTruthy();
        expect(screen.getByText('Fix before you share')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('playbook-basis-contract'));
        await fireEvent.press(screen.getByTestId('playbook-register-go'));
        const register = post.mock.calls.find((c) => String(c[0]).endsWith('/register'));
        expect(register?.[1]).toEqual({
            registration: { lawfulBasis: 'contract', retentionDays: undefined, retentionField: 'created_at', subjectColumn: undefined },
            risks: ['ropa_retention'],
        });
    });

    it('shows what landed when stopped, and resumes', async () => {
        await open(pb([ph('table', 'done', { artifacts: { datatableName: 'Contracts', rowCount: 4 } }), ph('routine', 'failed', { error: 'interrupted' })], { status: 'stopped' }));
        expect(await screen.findByText('Stopped — this is what landed')).toBeTruthy();
        expect(screen.getByText('stopped mid-build — resume to retry it')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('playbook-resume'));
        expect(patch).toHaveBeenCalledWith('/api/playbooks/pb_1', { expectedVersion: 3, status: 'active' }, { retry: false });
    });

    it('lists the phases and opens what one did', async () => {
        await open(pb([ph('table', 'done', { summary: 'Made the table', artifacts: { datatableName: 'Contracts', rowCount: 4 } }), ph('routine', 'ready')]));
        await fireEvent.press(screen.getByText('Phases'));
        await fireEvent.press(await screen.findByTestId('playbook-phase-table'));
        expect(await screen.findByText('Made the table')).toBeTruthy();
        expect(screen.getAllByText('Contracts · 4 rows').length).toBeGreaterThan(0);
    });
});

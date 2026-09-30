/**
 * The playbook list against canned answers: rows say how far each build is
 * and whether it waits for the person, and the New sheet goes describe →
 * compose → preview → Start → the new playbook's screen, sending the web's
 * create body.
 */

import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { PlaybooksScreen } from './PlaybooksScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
/* eslint-disable @typescript-eslint/no-require-imports -- a jest.mock factory loads the shared mocks lazily */
jest.mock('expo-router', () => require('@/shared/testing/screenMocks').expoRouter(() => mockPush));
jest.mock('@/core/api/client', () => require('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access', () => ({ ...jest.requireActual('@/core/access'), useHasPermission: () => true }));

// Mutations kept forever too: a finished mutation's gc timer would hold the worker open.
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const RECIPE = {
    title: 'Contract tracker',
    description: 'Contracts into a table, then an app',
    table: { fields: [{ key: 'supplier', name: 'Supplier', type: 'text' }] },
    inputs: [{ key: 'folderPath', label: 'Contracts folder', kind: 'folder', default: '/Contracts' }],
    phases: [{ key: 'table', label: 'Table' }, { key: 'routine', label: 'Automation' }],
};

beforeEach(() => {
    get.mockReset();
    post.mockReset();
    mockPush.mockReset();
    get.mockImplementation((path: string) => {
        if (path === '/api/playbooks') {
            return Promise.resolve({
                playbooks: [
                    { id: 'pb_1', title: 'Invoices', recipeLabel: 'Invoices', status: 'active', currentPhase: 'fill', progress: { done: 2, total: 5 }, phases: [{ key: 'fill', kind: 'fill', status: 'awaiting' }] },
                    { id: 'pb_2', title: 'Old one', status: 'done', progress: { done: 3, total: 3 }, phases: [] },
                ],
            });
        }
        if (path === '/ai/config/tiers-for-user') return Promise.resolve({ fast: { modelId: 'm' }, thinking: { modelId: 'm2' } });
        return Promise.resolve(null);
    });
});

describe('PlaybooksScreen', () => {
    it('lists the playbooks with their progress and status', async () => {
        await renderWithProviders(<PlaybooksScreen />, { queryClient: client() });
        expect(await screen.findByText('Invoices')).toBeTruthy();
        expect(screen.getByText(/2\/5 phases · First rows/)).toBeTruthy();
        expect(screen.getByText('Paused for you')).toBeTruthy();
        expect(screen.getByText('Done')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('playbook-row-pb_1'));
        expect(mockPush).toHaveBeenCalledWith('/playbooks/pb_1');
    });

    it('describes, composes, previews and starts a playbook', async () => {
        post.mockImplementation((path: string) =>
            Promise.resolve(path.endsWith('/compose') ? { recipe: RECIPE, warnings: [] } : { playbook: { id: 'pb_9', title: 'Contract tracker', status: 'active', phases: [], version: 1 } }),
        );
        await renderWithProviders(<PlaybooksScreen startNew />, { queryClient: client() });
        await fireEvent.changeText(await screen.findByTestId('playbook-describe'), 'Read my contracts');
        await fireEvent.press(screen.getByTestId('playbook-compose'));
        expect(await screen.findByTestId('playbook-recipe-preview')).toBeTruthy();
        expect(screen.getByText('Table → Automation')).toBeTruthy();
        expect(screen.getByText('Columns: Supplier (text)')).toBeTruthy();
        await fireEvent.press(screen.getByText('Start'));
        await screen.findByText('Invoices');
        const create = post.mock.calls.find((c) => c[0] === '/api/playbooks');
        expect(create?.[1]).toMatchObject({
            recipe: RECIPE,
            title: 'Contract tracker',
            options: { tableMode: 'new', inputs: { folderPath: '/Contracts' }, folderPath: '/Contracts', tier: 'fast', locale: 'en', ask: 'Read my contracts' },
        });
        expect(mockPush).toHaveBeenCalledWith('/playbooks/pb_9');
        expect(screen.queryByTestId('playbook-approver')).toBeNull();
    });

    it('offers an approver group when the recipe has an approval phase, and sends it', async () => {
        const withApproval = { ...RECIPE, phases: [...RECIPE.phases, { key: 'approve', label: 'Approval', requires: 'approvals' }] };
        post.mockImplementation((path: string) =>
            Promise.resolve(path.endsWith('/compose') ? { recipe: withApproval, warnings: [] } : { playbook: { id: 'pb_9', title: 'Contract tracker', status: 'active', phases: [], version: 1 } }),
        );
        const base = get.getMockImplementation() as (path: string) => Promise<unknown>;
        get.mockImplementation((path: string) => (path === '/auth/groups' ? Promise.resolve([{ id: 'g1', name: 'Finance' }]) : base(path)));
        await renderWithProviders(<PlaybooksScreen startNew />, { queryClient: client() });
        await fireEvent.changeText(await screen.findByTestId('playbook-describe'), 'Read my contracts');
        await fireEvent.press(screen.getByTestId('playbook-compose'));
        expect(await screen.findByText('Me (the owner)')).toBeTruthy();
        await fireEvent.press(await screen.findByTestId('playbook-approver-g1'));
        await fireEvent.press(screen.getByText('Start'));
        await screen.findByText('Invoices');
        const create = post.mock.calls.find((c) => c[0] === '/api/playbooks');
        expect(create?.[1].options).toMatchObject({ approverGroupId: 'g1' });
    });
});

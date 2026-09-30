/**
 * The manual editor against canned answers: it opens the concept, saves the
 * whole snapshot against the loaded rev, answers a 409 with "Keep mine", and
 * shows someone without edit rights the fields read-only with the reason.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api, ApiError } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { AgentEditScreen } from './AgentEditScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
let mockManage = true;
jest.mock('@/core/access', () => ({ ...jest.requireActual('@/core/access'), useHasPermission: () => mockManage }));

const AGENT = {
    id: 'a1',
    name: 'Helpdesk',
    description: 'IT questions',
    avatar: '🛠️',
    model: null,
    owner_id: 'u1',
    is_published: false,
    starter_prompts: '["Reset my password"]',
    config: { knowledge_base_ids: [] },
    organization_id: 'o1',
    shared_groups: [],
    rev: 5,
    can_edit: true,
    system_prompt: 'Be helpful.',
    published_version: 0,
};

let agent: Record<string, unknown>;

const wrap = (ui: ReactElement) => renderWithProviders(<ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider>);

beforeEach(() => {
    mockManage = true;
    agent = { ...AGENT };
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => {
        if (path === '/agents/a1') return Promise.resolve(agent);
        if (path === '/agents/categories') return Promise.resolve([{ id: 'c1', name: 'Support' }]);
        if (path === '/ai/config/tiers-for-user') return Promise.resolve({ auto: { auto: true }, fast: { modelId: 'm' } });
        if (path === '/api/kb') return Promise.resolve([{ id: 'kb1', name: 'Handbook' }]);
        return Promise.resolve(null);
    });
});

describe('AgentEditScreen', () => {
    it('opens the concept and saves the full snapshot against its rev', async () => {
        (api.put as jest.Mock).mockResolvedValue({ ...AGENT, name: 'Service desk', rev: 6 });
        await wrap(<AgentEditScreen id="a1" />);
        const name = await screen.findByDisplayValue('Helpdesk');
        expect(api.get).toHaveBeenCalledWith('/agents/a1', expect.objectContaining({ query: { draft: '1' } }));
        expect(screen.getByDisplayValue('Be helpful.')).toBeTruthy();
        expect(screen.getByDisplayValue('Reset my password')).toBeTruthy();

        await fireEvent.changeText(name, 'Service desk');
        await fireEvent.press(await screen.findByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalled());
        const [path, body] = (api.put as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
        expect(path).toBe('/agents/a1');
        expect(body).toMatchObject({ name: 'Service desk', systemPrompt: 'Be helpful.', starterPrompts: ['Reset my password'], baseVersion: 5 });
        expect(body).not.toHaveProperty('persona');
        await waitFor(() => expect(screen.queryByText('Save')).toBeNull());
    });

    it('refuses to send a nameless agent', async () => {
        await wrap(<AgentEditScreen id="a1" />);
        await fireEvent.changeText(await screen.findByDisplayValue('Helpdesk'), ' ');
        await fireEvent.press(await screen.findByText('Save'));
        expect((await screen.findAllByText('Give the agent a name.')).length).toBeGreaterThan(0);
        expect(api.put).not.toHaveBeenCalled();
    });

    it('keeps mine on a conflict by re-sending against the server rev', async () => {
        (api.put as jest.Mock)
            .mockRejectedValueOnce(new ApiError('changed', { status: 409, body: { conflict: true, currentVersion: 9, agent: { ...AGENT, rev: 9 } } }))
            .mockResolvedValueOnce({ ...AGENT, rev: 10 });
        await wrap(<AgentEditScreen id="a1" />);
        await fireEvent.changeText(await screen.findByDisplayValue('Be helpful.'), 'Be brief.');
        await fireEvent.press(await screen.findByText('Save'));
        await fireEvent.press(await screen.findByText('Keep mine'));
        await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
        expect((api.put as jest.Mock).mock.calls[1][1]).toMatchObject({ systemPrompt: 'Be brief.', baseVersion: 9 });
    });

    it('shows the fields read-only without manage_agents', async () => {
        mockManage = false;
        await wrap(<AgentEditScreen id="a1" />);
        expect(await screen.findByText(/You can open this agent but not change it/)).toBeTruthy();
        expect(screen.getByDisplayValue('Helpdesk').props.editable).toBe(false);
        expect(screen.queryByLabelText('Edit with AI')).toBeNull();
    });

    it('offers to publish saved changes that are not live yet', async () => {
        agent = { ...AGENT, published_version: 2, unpublishedChanges: 1 };
        (api.post as jest.Mock).mockResolvedValue({ publishedVersion: 3, unpublishedChanges: 0 });
        await wrap(<AgentEditScreen id="a1" />);
        await fireEvent.press(await screen.findByText('Publish new version'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/agents/a1/publish-version', undefined, { retry: false }));
    });
});

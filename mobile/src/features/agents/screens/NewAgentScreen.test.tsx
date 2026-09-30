/**
 * A new agent: "Create with AI" makes an empty agent and hands the sentence to
 * its Edit-with-AI screen, as the web's wizard does; the manual path posts
 * the form; and without manage_agents there is only the reason.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { NewAgentScreen } from './NewAgentScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
let mockManage = true;
jest.mock('@/core/access', () => ({ ...jest.requireActual('@/core/access'), useHasPermission: () => mockManage }));

const wrap = (ui: ReactElement) => renderWithProviders(<ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider>);

beforeEach(() => {
    mockManage = true;
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue([]);
    (api.post as jest.Mock).mockResolvedValue({ id: 'new1', name: 'x', config: {} });
});

describe('NewAgentScreen', () => {
    it('creates with AI through an empty agent and its refine screen', async () => {
        await wrap(<NewAgentScreen ai />);
        await fireEvent.press(await screen.findByText('Teamchat Q&A'));
        await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
        const [path, body] = (api.post as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
        expect(path).toBe('/agents');
        expect(body).toMatchObject({ name: 'Untitled agent', systemPrompt: '', config: { avatar: '🤖', enabledIntegrations: [] } });
        expect(mockRouter.replace).toHaveBeenCalledWith(
            `/agents/new1/refine?q=${encodeURIComponent('Teamchat Q&A: Answer questions in team chat using your documentation')}`,
        );
    });

    it('creates an empty agent by hand and opens it', async () => {
        await wrap(<NewAgentScreen ai={false} />);
        await fireEvent.changeText(await screen.findByPlaceholderText('Agent name'), 'Onboarding buddy');
        await fireEvent.press(await screen.findByText('Save'));
        await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/agents/new1'));
        expect((api.post as jest.Mock).mock.calls[0][1]).toMatchObject({ name: 'Onboarding buddy' });
    });

    it('explains, instead of offering a form, without manage_agents', async () => {
        mockManage = false;
        await wrap(<NewAgentScreen ai={false} />);
        expect(await screen.findByText(/Creating agents takes the permission to manage agents/)).toBeTruthy();
        expect(screen.queryByPlaceholderText('Agent name')).toBeNull();
    });
});

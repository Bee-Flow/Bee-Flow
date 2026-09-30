/**
 * The Agents list with no agents: someone who may create one gets the New
 * menu the header's button opens (the phone builds agents now); anyone else
 * learns who makes them — and nobody is sent to a desktop Agent Designer.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AgentList } from './AgentList';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter(() => mockPush));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
let mockManage = true;
jest.mock('@/core/access', () => ({ ...jest.requireActual('@/core/access'), useHasPermission: () => mockManage }));

beforeEach(() => {
    mockManage = true;
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue([]);
});

describe('AgentList, empty', () => {
    it('offers New agent to someone who may create one, with both ways to start', async () => {
        await renderScreen(<AgentList onOpen={jest.fn()} />);
        expect(await screen.findByText('No agents yet')).toBeTruthy();
        expect(screen.queryByText(/Agent Designer/)).toBeNull();
        await fireEvent.press(screen.getByText('New agent'));
        await fireEvent.press(await screen.findByText('Create with AI'));
        expect(mockPush).toHaveBeenCalledWith('/agents/new?ai=1');
    });

    it('tells anyone else that an administrator creates agents, and offers nothing', async () => {
        mockManage = false;
        await renderScreen(<AgentList onOpen={jest.fn()} />);
        expect(await screen.findByText(/An administrator creates the agents in your organisation/)).toBeTruthy();
        expect(screen.queryByText('New agent')).toBeNull();
    });
});

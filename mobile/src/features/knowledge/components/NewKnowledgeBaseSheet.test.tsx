/**
 * Creating a knowledge base. A refused create is said inline through
 * describeError — a plan limit reads as one, and the client's "HTTP 402"
 * placeholder never reaches the screen.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { NewKnowledgeBaseSheet } from './NewKnowledgeBaseSheet';

jest.setTimeout(60_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

describe('NewKnowledgeBaseSheet', () => {
    it('says a refused create in describeError’s words', async () => {
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('HTTP 402', { status: 402 }));
        const onCreated = jest.fn();
        await renderScreen(<NewKnowledgeBaseSheet visible onClose={jest.fn()} onCreated={onCreated} />);
        await fireEvent.changeText(screen.getByLabelText('Name'), 'Policies');
        await fireEvent.press(screen.getByLabelText('Create'));
        expect(await screen.findByText('Your organisation has used its allowance for this period.')).toBeTruthy();
        expect(screen.queryByText('HTTP 402')).toBeNull();
        expect(api.post).toHaveBeenCalledWith('/api/kb', { name: 'Policies', description: '' });
        expect(onCreated).not.toHaveBeenCalled();
    });
});

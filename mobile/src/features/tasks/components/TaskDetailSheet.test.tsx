/**
 * A task's sheet. The server hard-deletes a task, and Delete sits right under
 * "Pause this task" — so a tap asks first, cancelling keeps the task, and only
 * a confirmation deletes it.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { TaskDetailSheet } from './TaskDetailSheet';
import type { AiTask } from '../model/types';

jest.setTimeout(60_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const TASK: AiTask = {
    id: 't1',
    userId: 'me',
    title: 'Morning brief',
    prompt: 'What is on today?',
    repeatInterval: 'daily',
    nextRunAt: null,
    lastRunAt: null,
    lastResult: null,
    lastStatus: null,
    isActive: true,
    modelTier: null,
    runCount: null,
    timezone: null,
    createdAt: null,
    agentId: null,
    conversationId: null,
    daysOfWeek: null,
    timeOfDay: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    (api.delete as jest.Mock).mockResolvedValue({ success: true });
});

async function open() {
    const onClose = jest.fn();
    await renderScreen(<TaskDetailSheet task={TASK} onClose={onClose} />);
    await fireEvent.press(screen.getByTestId('task-delete'));
    expect(await screen.findByText('Delete this task?')).toBeTruthy();
    return onClose;
}

describe('TaskDetailSheet', () => {
    it('asks before deleting, and cancelling keeps the task', async () => {
        const onClose = await open();
        expect(screen.getByText('“Morning brief” stops running and cannot be restored.')).toBeTruthy();
        expect(api.delete).not.toHaveBeenCalled();

        await fireEvent.press(screen.getByText('Cancel'));
        expect(api.delete).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('deletes only once confirmed, then closes', async () => {
        const onClose = await open();
        // The sheet's own Delete renders first; the confirmation's is the last.
        const buttons = screen.getAllByLabelText('Delete');
        await fireEvent.press(buttons[buttons.length - 1]!);
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/ai-tasks/t1'));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});

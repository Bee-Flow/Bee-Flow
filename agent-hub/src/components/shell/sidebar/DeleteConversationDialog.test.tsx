import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteMemoriesByConversation } from '../../chat/memory/memoryApi';
import { toast } from '../../shared/Toast';
import DeleteConversationDialog from './DeleteConversationDialog';

vi.mock('../../chat/memory/memoryApi', () => ({ deleteMemoriesByConversation: vi.fn() }));

const forget = vi.mocked(deleteMemoriesByConversation);

beforeEach(() => { forget.mockReset(); forget.mockResolvedValue(0); vi.restoreAllMocks(); });

function setup(onDelete = vi.fn().mockResolvedValue(true)) {
    const onCancel = vi.fn();
    render(<DeleteConversationDialog open conversationId="conv-1" onCancel={onCancel} onDelete={onDelete} />);
    return { onDelete, onCancel };
}

describe('DeleteConversationDialog', () => {
    it('offers the checkbox, unchecked', () => {
        setup();
        expect(screen.getByRole('checkbox', { name: 'Also forget memories learned in this chat' })).not.toBeChecked();
    });

    it('unchecked: deletes the chat and never touches memory', async () => {
        const user = userEvent.setup();
        const { onDelete, onCancel } = setup();
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(onCancel).toHaveBeenCalled());
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(forget).not.toHaveBeenCalled();
    });

    it('checked: forgets the chat memories after the delete and puts the count in the toast', async () => {
        const user = userEvent.setup();
        forget.mockResolvedValue(3);
        const success = vi.spyOn(toast, 'success').mockReturnValue(1);
        const order: string[] = [];
        const onDelete = vi.fn(async () => { order.push('delete'); return true; });
        forget.mockImplementation(async () => { order.push('forget'); return 3; });
        setup(onDelete);
        await user.click(screen.getByRole('checkbox', { name: 'Also forget memories learned in this chat' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(success).toHaveBeenCalledWith('Chat deleted. Forgot 3 memories learned in it.'));
        expect(forget).toHaveBeenCalledWith('conv-1');
        expect(order).toEqual(['delete', 'forget']);
    });

    it('checked but the chat could not be deleted: the memories stay', async () => {
        const user = userEvent.setup();
        const onDelete = vi.fn().mockResolvedValue(false);
        const { onCancel } = setup(onDelete);
        await user.click(screen.getByRole('checkbox', { name: 'Also forget memories learned in this chat' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(onDelete).toHaveBeenCalled());
        expect(forget).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('a failed memory delete is said, not hidden', async () => {
        const user = userEvent.setup();
        forget.mockRejectedValue(new Error('x'));
        const error = vi.spyOn(toast, 'error').mockReturnValue(1);
        setup();
        await user.click(screen.getByRole('checkbox', { name: 'Also forget memories learned in this chat' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(error).toHaveBeenCalled());
    });
});

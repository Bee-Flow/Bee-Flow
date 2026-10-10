import React, { useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { deleteMemoriesByConversation } from '../../chat/memory/memoryApi';
import ConfirmDialog from '../../shared/ConfirmDialog';
import { toast } from '../../shared/Toast';

export interface DeleteConversationDialogProps {
    open: boolean;
    conversationId: string;
    onCancel: () => void;
    /** Deletes the conversation; resolves true when it is gone. */
    onDelete: () => Promise<boolean | void>;
}

/**
 * Asks before a conversation is deleted. The opt-in checkbox ("Also forget
 * memories learned in this chat") is unchecked every time: forgetting is
 * something the person chooses, never a side effect of cleaning up. The
 * memories go only after the conversation delete succeeded.
 */
export default function DeleteConversationDialog({ open, conversationId, onCancel, onDelete }: DeleteConversationDialogProps) {
    const { t } = useTranslation();
    const [forget, setForget] = useState(false);

    const confirm = async () => {
        const ok = await onDelete();
        if (ok === false) return;
        if (forget) {
            try {
                const n = await deleteMemoriesByConversation(conversationId);
                toast.success(n === 1
                    ? t('chat.memory.forgot_with_chat', 'Chat deleted. Forgot 1 memory learned in it.')
                    : t('chat.memory.forgot_with_chat_plural', 'Chat deleted. Forgot {count} memories learned in it.', { count: n }));
            } catch {
                toast.error(t('chat.memory.delete_forget_failed', 'Chat deleted, but its memories could not be removed. You can remove them under Manage memory.'));
            }
        }
        setForget(false);
        onCancel();
    };

    return (
        <ConfirmDialog
            open={open}
            title={t('chat.memory.delete_chat_title', 'Delete this chat?')}
            description={(
                <span className="block space-y-3">
                    <span className="block">{t('chat.memory.delete_chat_desc', 'The conversation is removed for good.')}</span>
                    <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--text-primary)]">
                        <input
                            type="checkbox"
                            checked={forget}
                            onChange={(e) => setForget(e.target.checked)}
                            className="mt-0.5 h-4 w-4 accent-[var(--accent-primary)]"
                        />
                        <span>{t('chat.memory.forget_with_chat', 'Also forget memories learned in this chat')}</span>
                    </label>
                </span>
            )}
            confirmLabel={t('common.delete', 'Delete')}
            cancelLabel={t('common.cancel', 'Cancel')}
            destructive
            onConfirm={confirm}
            onCancel={() => { setForget(false); onCancel(); }}
        />
    );
}

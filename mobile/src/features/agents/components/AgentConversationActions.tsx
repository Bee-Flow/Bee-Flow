/**
 * One agent conversation's actions — pin or unpin, rename, delete — as the
 * kit's ActionMenu, the drawer's chat menu (features/chat ChatActions) on an
 * agent's list and on the agent rows of the list of every conversation.
 *
 * It was an Alert with four buttons. Android draws at most three, so Cancel
 * fell off, and Delete sat in the positive slot and deleted at once. Here
 * Cancel is always the menu's last row and delete asks first: a conversation
 * is not coming back.
 *
 * Mounted per chosen conversation while its menu, rename sheet or
 * confirmation is open. Only a success closes it; a failure toasts
 * (useAgentConversationActions) or, for a rename, stays in the sheet.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { ActionMenu } from '@/shared/ui';

import { RenameDialog, type RenameTarget } from './RenameDialog';
import { useAgentConversationActions } from '../hooks/mutations';
import type { AgentConversationSummary } from '../model/types';

export interface AgentConversationActionsProps {
    agentId: string;
    /** What the menu reads; a cross-agent row carries these too. */
    conversation: Pick<AgentConversationSummary, 'id' | 'title' | 'pinned'>;
    menuOpen: boolean;
    onCloseMenu: () => void;
    /** Everything done: the caller unmounts this. */
    onClose: () => void;
}

export function AgentConversationActions({ agentId, conversation, menuOpen, onCloseMenu, onClose }: AgentConversationActionsProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { pin, rename, remove } = useAgentConversationActions(agentId);
    const [renaming, setRenaming] = useState<RenameTarget | null>(null);
    const title = conversation.title || t('sidebar.untitled_chat', 'Untitled Chat');

    const togglePin = () => pin.mutate({ conversationId: conversation.id, pinned: !conversation.pinned }, { onSuccess: onClose });

    const askToDelete = async () => {
        const ok = await confirm({
            title: t('mobile.agents.delete_conversation_title', 'Delete this conversation?'),
            message: t(
                'mobile.agents.delete_conversation_message',
                '“{title}” and every message in it are removed on every device you sign in to. This cannot be undone.',
                { title },
            ),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) remove.mutate(conversation.id, { onSuccess: onClose });
    };

    const openRename = () => {
        rename.reset();
        setRenaming({ id: conversation.id, title: conversation.title ?? '' });
    };

    const submitRename = (next: string) =>
        rename.mutate({ conversationId: conversation.id, title: next }, { onSuccess: onClose });

    return (
        <>
            <ActionMenu
                visible={menuOpen}
                onClose={onCloseMenu}
                title={title}
                items={[
                    conversation.pinned
                        ? { id: 'pin', label: t('sidebar.unpin', 'Unpin'), icon: 'PinOff', onPress: togglePin }
                        : { id: 'pin', label: t('sidebar.pin_to_top', 'Pin to top'), icon: 'Pin', onPress: togglePin },
                    { id: 'rename', label: t('sidebar.rename', 'Rename'), icon: 'Pencil', onPress: openRename },
                    { id: 'delete', label: t('common.delete', 'Delete'), icon: 'Trash2', destructive: true, onPress: () => void askToDelete() },
                ]}
            />
            <RenameDialog
                value={renaming}
                onChange={setRenaming}
                onSubmit={submitRename}
                submitting={rename.isPending}
                error={rename.error}
            />
        </>
    );
}

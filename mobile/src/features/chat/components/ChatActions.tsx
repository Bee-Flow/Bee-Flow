/**
 * A chat row's actions — the web ConvRow menu's rename, pin and delete, as
 * the phone's ActionMenu, through the SAME chat mutations the conversation's
 * details screen uses (so the list, the chat and the web all agree). The
 * drawer's chats (features/shell) and the list of every conversation
 * (features/conversations) both open it, so it lives with those mutations.
 *
 * Mounted per chosen conversation and kept mounted while its menu, rename
 * sheet or delete confirmation is open, so every mutation belongs to a live
 * component. Delete asks first: it removes the chat on every device.
 *
 * A pin or a delete that fails says so (a toast in describeError's words)
 * and leaves the actions standing; only a success closes them. The rename's
 * failure stays in its sheet, which is still open to try again.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { FormSheet, useConfirm } from '@/shared/patterns';
import { ActionMenu, TextField, useToast } from '@/shared/ui';

import { useDeleteConversation, usePatchConversation } from '../hooks/mutations';
import type { ConversationSummary } from '../model/types';

export interface ChatActionsProps {
    conversation: ConversationSummary;
    menuOpen: boolean;
    onCloseMenu: () => void;
    onClose: () => void;
}

export function ChatActions({ conversation, menuOpen, onCloseMenu, onClose }: ChatActionsProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const patch = usePatchConversation(conversation.id);
    // The drawer and the list sit over a tab or the list, never over the chat
    // they delete: stay put.
    const destroy = useDeleteConversation(conversation.id);
    const [draft, setDraft] = useState<string | null>(null);
    const title = conversation.title || t('sidebar.untitled_chat', 'Untitled Chat');
    const failed = (err: unknown) => toast(describeError(err).message, 'error');

    const remove = async () => {
        const ok = await confirm({
            title: t('mobile.nav.delete_chat_title', 'Delete this chat?'),
            message: t('mobile.nav.delete_chat_message', 'It is removed on every device you sign in to. This cannot be undone.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) destroy.mutate(undefined, { onSuccess: onClose, onError: failed });
    };

    const pin = (pinned: boolean) => patch.mutate({ pinned }, { onSuccess: onClose, onError: failed });

    const openRename = () => {
        // A pin that failed a moment ago is not this sheet's error.
        patch.reset();
        setDraft(conversation.title ?? '');
    };

    const rename = () => {
        const next = (draft ?? '').trim();
        if (!next) return;
        patch.mutate({ title: next }, { onSuccess: () => setDraft(null) });
    };

    return (
        <>
            <ActionMenu
                visible={menuOpen}
                onClose={onCloseMenu}
                title={title}
                items={[
                    { id: 'rename', label: t('sidebar.rename', 'Rename'), icon: 'Pencil', onPress: openRename },
                    conversation.pinned
                        ? { id: 'pin', label: t('sidebar.unpin', 'Unpin'), icon: 'PinOff', onPress: () => pin(false) }
                        : { id: 'pin', label: t('sidebar.pin_to_top', 'Pin to top'), icon: 'Pin', onPress: () => pin(true) },
                    { id: 'delete', label: t('common.delete', 'Delete'), icon: 'Trash2', destructive: true, onPress: () => void remove() },
                ]}
            />
            <FormSheet
                visible={draft !== null}
                onClose={() => setDraft(null)}
                title={t('sidebar.rename', 'Rename')}
                submitLabel={t('common.save', 'Save')}
                onSubmit={rename}
                submitting={patch.isPending}
                canSubmit={Boolean(draft?.trim())}
                error={patch.error}
            >
                <TextField
                    value={draft ?? ''}
                    onChangeText={setDraft}
                    autoFocus
                    accessibilityLabel={t('mobile.nav.chat_title', 'Chat title')}
                    returnKeyType="done"
                    onSubmitEditing={rename}
                />
            </FormSheet>
        </>
    );
}

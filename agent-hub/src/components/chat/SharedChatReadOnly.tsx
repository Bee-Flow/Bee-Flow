import { Eye } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * In place of the composer when a project member reads a colleague's chat
 * that was shared into the project without the right to continue it.
 *
 * The server answers such a read with `readOnly: true` (a viewer on the
 * project; `access.canPost` is false) and refuses every turn from them, so
 * offering a composer would only collect a message the server throws away.
 */

export interface SharedChatAccess {
    readOnly?: boolean;
    access?: { canPost?: boolean } | null;
}

/** The chat on screen may be read but not continued by this person. */
export function isReadOnlySharedChat(conversation: SharedChatAccess | null | undefined): boolean {
    if (!conversation) return false;
    return conversation.readOnly === true || conversation.access?.canPost === false;
}

export default function SharedChatReadOnly() {
    const { t } = useTranslation();
    return (
        <div
            className="mx-auto w-full max-w-3xl my-3 flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3 text-[13px] text-[var(--text-secondary)]"
            data-testid="shared-chat-read-only"
            role="note"
        >
            <Eye className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <span>{t('sidebar.shared_chat_read_only', 'This chat was shared with the project. You can read it; ask the project owner for editor access to continue it.')}</span>
        </div>
    );
}

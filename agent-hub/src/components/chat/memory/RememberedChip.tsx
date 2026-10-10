import { Check } from 'lucide-react';
import React, { useState } from 'react';
import useRememberedMemories from '../../../hooks/useRememberedMemories';
import { useTranslation } from '../../../hooks/useTranslation';
import { openMemoryPanel } from '../../../utils/memoryMode';
import { toast } from '../../shared/Toast';
import { deleteMemory } from './memoryApi';
import { shortMemory } from './memoryLabels';

export interface RememberedChipProps {
    conversationId: string;
    /** ISO time the turn started. */
    since: string;
    /** ISO time the next turn started; the chip then stops looking. */
    until?: string;
}

/**
 * "Remembered: …" under an answer, when the turn saved something. Undo forgets
 * what the turn saved (the server restores any fact it replaced); Edit opens the
 * memory panel. It appears without animation, and only once something was found.
 */
export default function RememberedChip({ conversationId, since, until }: RememberedChipProps) {
    const { t } = useTranslation();
    const { items } = useRememberedMemories({ conversationId, since, until, enabled: true });
    const [gone, setGone] = useState(false);
    const [busy, setBusy] = useState(false);

    if (gone || items.length === 0) return null;

    const first = shortMemory(items[0].summary || items[0].content);
    const more = items.length - 1;

    const undo = async () => {
        setBusy(true);
        const results = await Promise.allSettled(items.map(i => deleteMemory(i.id, { undo: true })));
        setBusy(false);
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
            toast.error(t('chat.memory.undo_failed', 'Could not undo that. You can remove it under Manage memory.'));
            return;
        }
        setGone(true);
        toast.success(items.length === 1
            ? t('chat.memory.undone', 'Forgotten again.')
            : t('chat.memory.undone_plural', 'Forgotten again ({count} memories).', { count: items.length }));
    };

    return (
        <div
            role="status"
            data-testid="memory-remembered"
            className="mt-2 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-1 text-xs text-[var(--text-secondary)]"
        >
            <Check className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" aria-hidden="true" />
            <span className="min-w-0 break-words">
                {more > 0
                    ? t('chat.memory.remembered_more', 'Remembered: {content} (+{count} more)', { content: first, count: more })
                    : t('chat.memory.remembered', 'Remembered: {content}', { content: first })}
            </span>
            <button
                type="button"
                onClick={undo}
                disabled={busy}
                className="rounded px-1 underline hover:text-[var(--text-primary)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
            >
                {t('chat.memory.undo', 'Undo')}
            </button>
            <button
                type="button"
                onClick={openMemoryPanel}
                className="rounded px-1 underline hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
            >
                {t('chat.memory.edit', 'Edit')}
            </button>
        </div>
    );
}

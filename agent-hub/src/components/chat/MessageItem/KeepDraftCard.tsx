import { StickyNote, Check, Trash2, Plus, ListChecks } from 'lucide-react';
import React, { type Dispatch, type SetStateAction } from 'react';
import DraftCardShell from './DraftCardShell';
import useDraftAction, { type DraftStatusMap } from '../../../hooks/useDraftAction';
import useTranslation from '../../../hooks/useTranslation';

interface KeepListItem {
    checked?: boolean;
    text?: string;
}

interface KeepDraft {
    action?: string;
    type?: string;
    title?: string;
    content?: string;
    listItems?: KeepListItem[];
    [key: string]: unknown;
}

interface KeepDraftCardProps {
    msg: { keepDrafts?: KeepDraft[] };
    keepDraftStatuses: DraftStatusMap;
    setKeepDraftStatuses: Dispatch<SetStateAction<DraftStatusMap>>;
}

export default function KeepDraftCard({ msg, keepDraftStatuses, setKeepDraftStatuses }: KeepDraftCardProps) {
    const { t } = useTranslation();
    const { confirm, discard, getStatus } = useDraftAction({
        endpoint: '/api/integrations/keep/execute',
        statuses: keepDraftStatuses,
        setStatuses: setKeepDraftStatuses,
    });

    if (!msg.keepDrafts || msg.keepDrafts.length === 0) return null;

    const isDelete = (draft: KeepDraft) => draft.action === 'delete';

    return msg.keepDrafts.map((draft: KeepDraft, i: number) => {
        const status = getStatus(draft, i);

        const colors = isDelete(draft)
            ? { border: 'border-red-500/30', bg: 'bg-red-500/5', text: 'text-red-500', btn: 'bg-red-600 hover:bg-red-500' }
            : { border: 'border-amber-500/30', bg: 'bg-amber-500/5', text: 'text-amber-500', btn: 'bg-amber-600 hover:bg-amber-500' };

        const ActionIcon = isDelete(draft) ? Trash2 : Plus;
        const actionLabel = t(
            isDelete(draft) ? 'chat.draft.keep_delete' : 'chat.draft.keep_new',
            isDelete(draft) ? 'Delete Note' : 'New Note',
        );
        const NoteTypeIcon = draft.type === 'list' ? ListChecks : StickyNote;

        return (
            <DraftCardShell
                key={i}
                status={status}
                colors={colors}
                icon={ActionIcon}
                actionLabel={actionLabel}
                executingLabel={t('chat.draft.saving', 'Saving...')}
                titleIcon={NoteTypeIcon}
                title={draft.title || t('chat.draft.untitled', '(untitled)')}
                onConfirm={() => confirm(draft, i)}
                onDiscard={() => discard(i)}
            >
                {/* Text content */}
                {draft.content && (
                    <div className="text-[var(--text-secondary)] text-xs pl-6 whitespace-pre-wrap leading-relaxed" style={{ maxHeight: '120px', overflow: 'auto' }}>
                        {draft.content}
                    </div>
                )}

                {/* List items */}
                {draft.listItems && draft.listItems.length > 0 && (
                    <div className="pl-6 space-y-1">
                        {draft.listItems.map((item: KeepListItem, j: number) => (
                            <div key={j} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                                <div className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${
                                    item.checked ? 'bg-amber-500/20 border-amber-500/50' : 'border-[var(--border-subtle)]'
                                }`}>
                                    {item.checked && <Check className="w-2.5 h-2.5 text-amber-500" />}
                                </div>
                                <span className={item.checked ? 'line-through opacity-60' : ''}>{item.text}</span>
                            </div>
                        ))}
                    </div>
                )}
            </DraftCardShell>
        );
    });
}

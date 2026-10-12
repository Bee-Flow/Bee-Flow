import { Pencil, Trash2, ExternalLink, Folder, Bot, ShieldAlert } from 'lucide-react';
import React from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import { formatRelativeTime } from '../../../utils/dateFormatters';
import IconButton from '../../shared/IconButton';
import MemoryEditor, { type MemoryDraft } from './MemoryEditor';
import {
    TYPE_ICONS, isMemoryType, originLabel, sourceChatHref, typeSingularLabel, addableTypes,
    type Memory,
} from './memoryTypes';

const BADGE = 'inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]';

interface MemoryRowProps {
    memory: Memory;
    canWrite: boolean;
    selectMode?: boolean;
    selected?: boolean;
    editing?: boolean;
    showCreator?: boolean;
    /** Replaces the edit / delete buttons (restore, approve, reject). */
    actions?: React.ReactNode;
    onToggleSelect?: (id: string) => void;
    onEdit?: (id: string) => void;
    onDelete?: (id: string) => void;
    onSaveEdit?: (id: string, draft: MemoryDraft) => void;
    onCancelEdit?: () => void;
}

const preview = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

export default function MemoryRow({
    memory, canWrite, selectMode = false, selected = false, editing = false, showCreator = false,
    actions, onToggleSelect, onEdit, onDelete, onSaveEdit, onCancelEdit,
}: MemoryRowProps) {
    const { t } = useTranslation();
    const TypeIcon = isMemoryType(memory.type) ? TYPE_ICONS[memory.type] : TYPE_ICONS.fact;
    const href = sourceChatHref(memory);
    const name = preview(memory.content);
    const lastUsed = memory.last_used_at
        ? t('knowledge.memory_last_used', 'Last used {when}', {
            when: formatRelativeTime(memory.last_used_at, { nowLabel: t('knowledge.memory_just_now', 'just now') }),
        })
        : t('knowledge.memory_never_used', 'Never used');

    return (
        <li
            data-testid={`memory-item-${memory.id}`}
            className={`rounded-xl border p-4 ${selected ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]'}`}
        >
            <div className="flex items-start gap-3">
                {selectMode && canWrite && (
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => onToggleSelect?.(memory.id)}
                        aria-label={t('knowledge.memory_select_one', 'Select memory: {preview}', { preview: name })}
                        className="mt-1 h-4 w-4 flex-shrink-0 accent-[var(--accent-primary)]"
                    />
                )}
                <div className="flex-1 min-w-0">
                    {editing ? (
                        <MemoryEditor
                            initial={{ content: memory.content, type: memory.type, importance: memory.importance ?? 0.5 }}
                            types={addableTypes(!!memory.project_id)}
                            onSave={(draft) => onSaveEdit?.(memory.id, draft)}
                            onCancel={() => onCancelEdit?.()}
                        />
                    ) : (
                        <>
                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-primary)]">
                                {memory.content}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <span className={BADGE}>
                                    <TypeIcon className="h-3 w-3" aria-hidden="true" />
                                    {typeSingularLabel(t, memory.type)}
                                </span>
                                <span className={BADGE}>{originLabel(t, memory.origin)}</span>
                                {memory.sensitivity === 'art9' && (
                                    <span className={BADGE}>
                                        <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                                        {t('knowledge.memory_sensitive', 'Sensitive')}
                                    </span>
                                )}
                                {memory.agent_name && (
                                    <span className={BADGE}>
                                        <Bot className="h-3 w-3" aria-hidden="true" />
                                        {memory.agent_name}
                                    </span>
                                )}
                                {memory.project_name && (
                                    <span className={BADGE}>
                                        <Folder className="h-3 w-3" aria-hidden="true" />
                                        {memory.project_name}
                                    </span>
                                )}
                            </div>
                            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
                                <span>{lastUsed}</span>
                                {memory.created_at && (
                                    <span>{t('knowledge.memory_added', 'Added {when}', {
                                        when: formatRelativeTime(memory.created_at, { nowLabel: t('knowledge.memory_just_now', 'just now') }),
                                    })}</span>
                                )}
                                {showCreator && memory.created_by_name && (
                                    <span>{t('knowledge.memory_by', '• by {name}', { name: memory.created_by_name })}</span>
                                )}
                                {href && (
                                    <a
                                        href={href}
                                        className="inline-flex items-center gap-1 text-[var(--accent-primary)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                                    >
                                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                        {memory.origin === 'inferred'
                                            ? t('knowledge.memory_learned_in_chat', 'Learned in this chat')
                                            : t('knowledge.memory_source_chat', 'Open source chat')}
                                    </a>
                                )}
                            </p>
                        </>
                    )}
                </div>
                {!editing && (actions ?? (canWrite && !selectMode && (
                    <div className="flex flex-shrink-0 items-center gap-0.5">
                        <IconButton
                            ariaLabel={t('knowledge.memory_edit_named', 'Edit memory: {preview}', { preview: name })}
                            onClick={() => onEdit?.(memory.id)}
                        >
                            <Pencil />
                        </IconButton>
                        <IconButton
                            variant="danger"
                            ariaLabel={t('knowledge.memory_delete_named', 'Delete memory: {preview}', { preview: name })}
                            onClick={() => onDelete?.(memory.id)}
                        >
                            <Trash2 />
                        </IconButton>
                    </div>
                )))}
            </div>
        </li>
    );
}

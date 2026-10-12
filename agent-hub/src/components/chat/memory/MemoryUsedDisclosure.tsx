import { Brain, ChevronRight, Clock, Folder, Info, ListChecks, SlidersHorizontal, User, Workflow, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import type { ChatMessage, MemoryUsedItem } from '../../../hooks/useChatEngine/types';
import { openMemoryPanel } from '../../../utils/memoryMode';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import { toast } from '../../shared/Toast';
import { deleteMemory, fetchMemoriesByIds } from './memoryApi';
import { memoryTypeLabel } from './memoryLabels';

/**
 * The memories an answer drew on. Live from the `memory_used` event, and after a
 * reload from the message the server persisted (`memoryUsed`, or the same list
 * inside `meta` / `metadata`). The persisted list has ids and types only; the
 * previews are fetched once, when the person expands the list.
 */
export function memoryUsedOf(msg: ChatMessage | null | undefined): MemoryUsedItem[] {
    if (!msg) return [];
    const pick = (v: unknown): MemoryUsedItem[] => (Array.isArray(v)
        ? v.filter((i): i is MemoryUsedItem => !!i && typeof i === 'object' && typeof (i as MemoryUsedItem).id === 'string')
        : []);
    const meta = msg.meta as { memoryUsed?: unknown } | undefined;
    const metadata = msg.metadata as { memoryUsed?: unknown } | undefined;
    const direct = pick(msg.memoryUsed);
    if (direct.length > 0) return direct;
    const fromMeta = pick(meta?.memoryUsed);
    return fromMeta.length > 0 ? fromMeta : pick(metadata?.memoryUsed);
}

const TYPE_ICON: Record<string, LucideIcon> = {
    instruction: ListChecks,
    preference: SlidersHorizontal,
    person: User,
    project: Folder,
    workflow: Workflow,
    fact: Info,
    context: Clock,
};

type Forgetting = 'busy' | 'done';

export default function MemoryUsedDisclosure({ items }: { items: MemoryUsedItem[] }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const listId = useId();
    // id -> preview, filled once on the first expand when the list came without previews.
    const [fetched, setFetched] = useState<Record<string, string> | null>(null);
    const [forgetting, setForgetting] = useState<Record<string, Forgetting>>({});
    const needsFetch = items.some(i => !i.preview);
    useEffect(() => {
        if (!open || !needsFetch || fetched) return undefined;
        const controller = new AbortController();
        fetchMemoriesByIds(items.map(i => i.id), controller.signal)
            .then(found => setFetched(Object.fromEntries(found.map(m => [m.id, m.summary || m.content || '']))))
            .catch(() => { if (!controller.signal.aborted) setFetched({}); });
        return () => controller.abort();
    }, [open, needsFetch, fetched]);
    if (items.length === 0) return null;

    const forget = async (id: string) => {
        setForgetting(f => ({ ...f, [id]: 'busy' }));
        try {
            await deleteMemory(id);
            setForgetting(f => ({ ...f, [id]: 'done' }));
            toast.success(t('chat.memory.forgotten', 'Forgotten'));
        } catch {
            setForgetting(f => { const { [id]: _drop, ...rest } = f; return rest; });
            toast.error(t('chat.memory.forget_failed', 'Could not forget this memory.'));
        }
    };

    const textOf = (item: MemoryUsedItem) => item.preview
        || (fetched === null
            ? t('chat.memory.used_loading', 'Loading…')
            : fetched[item.id] || t('chat.memory.used_gone', 'No longer available'));

    const row = (item: MemoryUsedItem) => {
        const Icon = TYPE_ICON[item.type] ?? Info;
        const label = memoryTypeLabel(t, item.type);
        const state = forgetting[item.id];
        const text = textOf(item);
        return (
            <li
                key={item.id}
                className={`group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--bg-tertiary)] focus-within:bg-[var(--bg-tertiary)] ${state === 'done' ? 'opacity-50' : ''}`}
                data-testid="memory-used-row"
            >
                <span title={label} aria-label={label} role="img" className="shrink-0 text-[var(--text-tertiary)]">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span
                    title={text}
                    tabIndex={0}
                    className={`min-w-0 flex-1 truncate focus:whitespace-normal focus:break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] ${state === 'done' ? 'line-through' : ''}`}
                >
                    {text}
                </span>
                {state === 'done' ? (
                    <span className="shrink-0 text-[var(--text-tertiary)]">{t('chat.memory.forgotten', 'Forgotten')}</span>
                ) : (
                    <button
                        type="button"
                        disabled={state === 'busy'}
                        onClick={() => { void forget(item.id); }}
                        aria-label={t('chat.memory.forget', 'Forget this memory')}
                        title={t('chat.memory.forget', 'Forget this memory')}
                        className="shrink-0 rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                )}
            </li>
        );
    };

    // Messages from before `why` existed count as relevant.
    const profile = items.filter(i => i.why === 'profile');
    const relevant = items.filter(i => i.why !== 'profile');
    const sections = [
        { key: 'profile', rows: profile, title: t('chat.memory.group_profile', 'Always used'), desc: t('chat.memory.group_profile_desc', 'Your standing instructions and preferences') },
        { key: 'relevant', rows: relevant, title: t('chat.memory.group_relevant', 'Relevant to this message'), desc: '' },
    ].filter(s => s.rows.length > 0);
    const grouped = sections.length > 1;

    return (
        <div className="mt-2 text-xs text-[var(--text-secondary)]" data-testid="memory-used">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen(o => !o)}
                className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                data-testid="memory-used-toggle"
            >
                <Brain className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{nOf(t, 'chat.memory.used', items.length, 'Used 1 memory', 'Used {count} memories')}</span>
                <ChevronRight className={`h-3 w-3 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
            </button>
            {open && (
                <div
                    id={listId}
                    role="region"
                    aria-label={t('chat.memory.used_list', 'Memories used for this answer')}
                    className="mt-1.5 max-w-xl rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
                    data-testid="memory-used-card"
                >
                    <div className="max-h-64 overflow-y-auto p-1.5" data-testid="memory-used-scroll">
                        {sections.map(sec => (
                            <section key={sec.key} aria-label={grouped || sec.key === 'profile' ? sec.title : undefined} className="mb-1 last:mb-0">
                                {(grouped || sec.key === 'profile') && (
                                    <div className="px-1.5 pb-0.5 pt-1">
                                        <h4 className="text-[11px] font-medium text-[var(--text-secondary)]">{sec.title}</h4>
                                        {sec.desc && <p className="text-[11px] text-[var(--text-tertiary)]">{sec.desc}</p>}
                                    </div>
                                )}
                                <ul>{sec.rows.map(row)}</ul>
                            </section>
                        ))}
                    </div>
                    <div className="flex justify-end border-t border-[var(--border-subtle)] px-1.5 py-1">
                        <button
                            type="button"
                            onClick={openMemoryPanel}
                            className="rounded-md px-2 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                        >
                            {t('chat.memory.manage', 'Manage memory')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

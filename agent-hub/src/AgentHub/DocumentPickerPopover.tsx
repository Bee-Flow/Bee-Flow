import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { apiClient } from '../api/client';
import useDebouncedValue from '../hooks/useDebouncedValue';
import useTranslation from '../hooks/useTranslation';
import { formatRelativeTime } from '../utils/dateFormatters';

interface PickerDocument {
    id: string;
    name?: string;
    docType?: string;
    updatedAt?: string;
}

interface Props {
    anchorRef: RefObject<HTMLElement | null>;
    open: boolean;
    onClose: () => void;
    onSelect: (id: string) => void;
}

/**
 * Compact popover listing the user's documents, for the chat header's
 * "Documents" button. Choosing one opens it in the side panel; the AI reads
 * only that document. Same shape as WebpagePickerPopover.
 */
export default function DocumentPickerPopover({ anchorRef, open, onClose, onSelect }: Props) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const popoverRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const [search, setSearch] = useState('');
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState(false);
    const term = useDebouncedValue(search.trim(), 200);

    const list = useQuery<PickerDocument[], Error>({
        queryKey: ['chat-document-picker', term],
        enabled: open,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ documents?: PickerDocument[] }>('/api/studio-documents', {
                signal,
                query: { kind: 'document', sort: 'updated', limit: 50, ...(term ? { query: term } : {}) },
            });
            return Array.isArray(body?.documents) ? body!.documents! : [];
        },
    });

    useEffect(() => {
        if (!open) return;
        searchRef.current?.focus();
        const onDoc = (e: MouseEvent) => {
            const target = e.target as Node;
            if (popoverRef.current?.contains(target)) return;
            if (anchorRef.current?.contains(target)) return;
            onClose();
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open, onClose, anchorRef]);

    if (!open) return null;

    const choose = (id: string) => { onSelect(id); onClose(); };

    const createPage = async () => {
        setCreating(true);
        setCreateError(false);
        try {
            const body = await apiClient.post<{ document?: { id?: string }; id?: string }>('/api/studio-documents', {
                name: t('documents.untitled_page', 'Untitled page'),
                docType: 'page',
                kind: 'document',
            });
            const id = body?.document?.id ?? body?.id;
            if (!id) throw new Error('no id');
            void qc.invalidateQueries({ queryKey: ['chat-document-picker'] });
            choose(id);
        } catch {
            setCreateError(true);
        } finally {
            setCreating(false);
        }
    };

    const items = list.data ?? [];

    return (
        <div
            ref={popoverRef}
            role="dialog"
            aria-label={t('chat.documents_picker_title', 'Open a document')}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
            className="absolute z-30 right-0 top-full mt-1 w-[320px] rounded-xl border shadow-xl overflow-hidden bg-[var(--bg-primary)] border-[var(--border-default)]"
        >
            <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
                <div className="text-xs font-medium text-[var(--text-primary)]">
                    {t('chat.documents_picker_title', 'Open a document')}
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)]">
                    {t('chat.documents_picker_hint', 'The AI only reads the document you open here.')}
                </div>
            </div>
            <div className="px-2 py-2 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                    <input
                        ref={searchRef}
                        type="text"
                        aria-label={t('chat.documents_picker_search', 'Search documents')}
                        placeholder={t('chat.documents_picker_search', 'Search documents')}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border outline-none bg-[var(--bg-secondary)] text-[var(--text-primary)] border-[var(--border-subtle)]"
                    />
                </div>
                <button
                    type="button"
                    onClick={createPage}
                    disabled={creating}
                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg border text-xs font-medium border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                >
                    {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    {t('chat.documents_picker_new_page', 'New page')}
                </button>
            </div>
            <div className="max-h-[300px] overflow-y-auto">
                {createError && (
                    <div role="alert" className="px-4 py-2 text-xs text-center text-[var(--text-tertiary)]">
                        {t('chat.documents_picker_create_error', 'Could not create the page.')}
                    </div>
                )}
                {list.isPending && (
                    <div className="py-6 flex items-center justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                    </div>
                )}
                {list.isError && (
                    <div role="alert" className="px-4 py-6 text-xs text-center text-[var(--text-tertiary)]">
                        {t('chat.documents_picker_error', 'Could not load your documents.')}
                    </div>
                )}
                {list.isSuccess && items.length === 0 && (
                    <div className="px-4 py-6 text-xs text-center text-[var(--text-tertiary)]">
                        {t('chat.documents_picker_empty', 'No documents yet.')}
                    </div>
                )}
                {items.map((d) => (
                    <button
                        key={d.id}
                        type="button"
                        onClick={() => choose(d.id)}
                        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                        <FileText className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate text-[var(--text-primary)]">
                                {d.name || t('documents.untitled_page', 'Untitled page')}
                            </div>
                            <div className="text-[10px] text-[var(--text-tertiary)]">
                                {[d.docType, d.updatedAt ? formatRelativeTime(d.updatedAt) : ''].filter(Boolean).join(' · ')}
                            </div>
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
}

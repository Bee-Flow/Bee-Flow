// "Add existing": a searchable list of the caller's own items, each with an
// Add button. Shared by documents, notebooks, meetings and knowledge bases.
//
// Items stay listed after they are added (marked as added) so several can be
// picked in one go, and a refusal is shown on the row it belongs to.

import { Check, Loader2, Plus, Search } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';
import Modal from '../../../shared/Modal';
import { SectionError } from './contentUi';

export interface PickerItem {
    id: string;
    label: string;
    /** A short second line: a date, a type, "in another project". */
    meta?: string;
}

export interface ItemPickerDialogProps {
    open: boolean;
    onClose: () => void;
    title: string;
    description?: string;
    loading: boolean;
    /** Set when the list itself could not be loaded. */
    error: string | null;
    onRetry?: () => void;
    items: PickerItem[];
    /** Ids already in the project: shown as added, not offered again. */
    alreadyIn: ReadonlySet<string>;
    /** Resolves when the item is in; rejects with the reason it was refused. */
    onPick: (id: string) => Promise<unknown>;
    emptyText: string;
}

interface RowProps {
    item: PickerItem;
    added: boolean;
    busy: boolean;
    disabled: boolean;
    error: string | undefined;
    onAdd: () => void;
}

function PickerRow({ item, added, busy, disabled, error, onAdd }: RowProps) {
    const { t } = useTranslation();
    return (
        <li className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-subtle)] last:border-b-0">
            <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{item.label}</div>
                {item.meta && <div className="text-[11px] text-[var(--text-tertiary)] truncate">{item.meta}</div>}
                {error && <div role="alert" className="text-[11px] text-[var(--error)] mt-0.5">{error}</div>}
            </div>
            {added ? (
                <span className="inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)]">
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('project_content.picker_added', 'Added')}
                </span>
            ) : (
                <button
                    type="button"
                    onClick={onAdd}
                    disabled={disabled}
                    aria-label={t('project_content.picker_add_named', 'Add {name}', { name: item.label })}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[12px] font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
                    {t('project_content.picker_add', 'Add')}
                </button>
            )}
        </li>
    );
}

function usePicking(onPick: (id: string) => Promise<unknown>) {
    const { t } = useTranslation();
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [added, setAdded] = useState<Set<string>>(() => new Set());
    const [errors, setErrors] = useState<Record<string, string>>({});
    const pick = async (id: string) => {
        setPendingId(id);
        setErrors(prev => ({ ...prev, [id]: '' }));
        try {
            await onPick(id);
            setAdded(prev => new Set(prev).add(id));
        } catch (e) {
            setErrors(prev => ({ ...prev, [id]: projectErrorText(t, e, t('project_content.picker_add_failed', 'Could not add it to the project')) }));
        } finally {
            setPendingId(null);
        }
    };
    return { pendingId, added, errors, pick };
}

function PickerBody({ loading, error, onRetry, rows, emptyText, children }: {
    loading: boolean; error: string | null; onRetry?: () => void; rows: number; emptyText: string; children: React.ReactNode;
}) {
    const { t } = useTranslation();
    if (loading) {
        return (
            <div className="flex items-center gap-2 py-6 justify-center text-sm text-[var(--text-tertiary)]" role="status">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                {t('project_content.picker_loading', 'Loading…')}
            </div>
        );
    }
    if (error) return <SectionError message={error} onRetry={onRetry} />;
    if (rows === 0) return <p className="px-3 py-6 text-center text-sm text-[var(--text-tertiary)]">{emptyText}</p>;
    return <>{children}</>;
}

export default function ItemPickerDialog({ open, onClose, title, description, loading, error, onRetry, items, alreadyIn, onPick, emptyText }: ItemPickerDialogProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const { pendingId, added, errors, pick } = usePicking(onPick);
    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? items.filter(i => i.label.toLowerCase().includes(q)) : items;
    }, [items, query]);

    const footer = (
        <button type="button" onClick={onClose} className="h-8 px-3 rounded-lg text-[13px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]">
            {t('project_content.picker_done', 'Done')}
        </button>
    );

    return (
        <Modal open={open} onClose={onClose} title={title} description={description} size="md" footer={footer}>
            <label className="relative block mb-3">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label={t('project_content.picker_search', 'Search')}
                    placeholder={t('project_content.picker_search', 'Search')}
                    className="w-full pl-8 pr-2 py-1.5 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                />
            </label>
            <PickerBody loading={loading} error={error} onRetry={onRetry} rows={visible.length} emptyText={emptyText}>
                <ul className="max-h-[360px] overflow-y-auto custom-scrollbar rounded-lg border border-[var(--border-subtle)]" data-testid="item-picker-list">
                    {visible.map(item => (
                        <PickerRow
                            key={item.id}
                            item={item}
                            added={alreadyIn.has(item.id) || added.has(item.id)}
                            busy={pendingId === item.id}
                            disabled={pendingId !== null}
                            error={errors[item.id] || undefined}
                            onAdd={() => { pick(item.id); }}
                        />
                    ))}
                </ul>
            </PickerBody>
        </Modal>
    );
}

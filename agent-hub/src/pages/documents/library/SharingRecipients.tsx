import React, { useId, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, UserRound, UsersRound, X } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';

interface Principal { id: string; name: string }
export interface SharingDirectory { users: Principal[]; groups: Principal[] }
type Field = 'sharedGroups' | 'sharedUserIds';
type Selection = Record<Field, string[]>;
type Tab = 'groups' | 'users' | 'selected';
interface Recipient extends Principal { kind: 'groups' | 'users'; field: Field; selected: boolean }
interface Props {
    value: Selection; directory?: SharingDirectory; loading: boolean; pending: boolean; empty: boolean;
    toggle: (field: Field, id: string) => void; clear: () => void;
}
const TABS: Tab[] = ['groups', 'users', 'selected'];
const PAGE_SIZE = 6;
const CHIP_LIMIT = 3;
const ICON_BUTTON = 'p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-40';

export default function SharingRecipients({ value, directory, loading, pending, empty, toggle, clear }: Props) {
    const { t } = useTranslation();
    const id = useId();
    const [tab, setTab] = useState<Tab>('groups');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(0);
    const entries = useMemo(() => (['groups', 'users'] as const).flatMap((kind): Recipient[] => {
        const field = kind === 'groups' ? 'sharedGroups' : 'sharedUserIds';
        const selected = new Set(value[field]);
        const available = directory?.[kind] || [];
        const known = new Set(available.map((p) => p.id));
        const missing = loading ? [] : value[field].filter((key) => !known.has(key)).map((key) => ({ id: key, name: t('documents.sharing.unavailable', 'Unavailable ({id})', { id: key }) }));
        return [...available, ...missing].map((p) => ({ ...p, kind, field, selected: selected.has(p.id) }));
    }), [directory, value.sharedGroups, value.sharedUserIds, loading, t]);
    const selected = entries.filter((p) => p.selected);
    const query = search.trim().toLocaleLowerCase();
    const results = entries.filter((p) => (tab === 'selected' ? p.selected : p.kind === tab) && p.name.toLocaleLowerCase().includes(query));
    const currentPage = Math.min(page, Math.max(0, Math.ceil(results.length / PAGE_SIZE) - 1));
    const visible = results.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    const chooseTab = (next: Tab) => { setTab(next); setPage(0); if (next === 'selected') setSearch(''); };
    const reviewSelected = () => { chooseTab('selected'); setSearch(''); };
    const tabLabel = (kind: Tab) => {
        if (kind === 'selected') return t('documents.sharing.selected', 'Selected ({count})', { count: selected.length });
        const label = kind === 'groups' ? t('documents.sharing.groups', 'Groups') : t('documents.sharing.users', 'Users');
        return `${label} (${directory?.[kind].length || 0})`;
    };
    const tabKeys = (e: React.KeyboardEvent<HTMLButtonElement>, kind: Tab) => {
        const next = nextTab(e.key, kind);
        if (!next) return;
        e.preventDefault(); chooseTab(next);
        document.getElementById(`${id}-${next}`)?.focus();
    };

    return <section className="space-y-3">
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
                <button type="button" disabled={pending} onClick={reviewSelected} className="font-medium text-[var(--text-primary)] hover:underline">{t('documents.sharing.selected', 'Selected ({count})', { count: selected.length })}</button>
                {!!selected.length && <button type="button" disabled={pending} onClick={clear} className="text-[var(--text-secondary)] hover:underline">{t('documents.sharing.clear_selection', 'Clear selection')}</button>}
            </div>
            {!!selected.length && <div className="flex flex-wrap gap-1.5">
                {selected.slice(0, CHIP_LIMIT).map((p) => <RecipientChip key={`${p.kind}:${p.id}`} recipient={p} pending={pending} toggle={toggle} />)}
                {selected.length > CHIP_LIMIT && <button type="button" disabled={pending} className="rounded-full border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)]" onClick={reviewSelected}>{t('documents.sharing.more_selected', '+{count} more', { count: selected.length - CHIP_LIMIT })}</button>}
            </div>}
        </div>
        <div className="rounded-xl border border-[var(--border-default)] overflow-hidden">
            <div role="tablist" aria-label={t('documents.sharing.recipient_type', 'Recipient type')} className="flex gap-1 p-1 border-b border-[var(--border-default)] bg-[var(--bg-card)]">
                {TABS.map((kind) => <button key={kind} id={`${id}-${kind}`} type="button" role="tab" aria-selected={tab === kind} aria-controls={`${id}-results`} tabIndex={tab === kind ? 0 : -1} disabled={pending} onClick={() => chooseTab(kind)} onKeyDown={(e) => tabKeys(e, kind)}
                    className={`flex-1 min-w-0 rounded-lg px-2 py-2 text-xs font-medium ${tab === kind ? 'bg-[var(--item-hover-bg)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]'}`}>{tabLabel(kind)}</button>)}
            </div>
            <div className="relative m-2">
                <Search size={15} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <input type="search" value={search} disabled={pending} onChange={(e) => { setSearch(e.target.value); setPage(0); }} aria-label={t('documents.sharing.search', 'Search users and groups')} placeholder={t('documents.sharing.search', 'Search users and groups')}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] pl-9 pr-3 py-2 text-sm" />
            </div>
            <div id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-${tab}`} aria-busy={loading} className="min-h-[124px]">
                {loading ? <p role="status" className="p-4 text-sm text-[var(--text-secondary)]">{t('documents.sharing.loading_people', 'Loading users and groups…')}</p> : <RecipientResults recipients={visible} selectedTab={tab === 'selected'} pending={pending} toggle={toggle} />}
            </div>
            {!!results.length && <div className="flex items-center justify-between border-t border-[var(--border-default)] px-3 py-1.5">
                <span role="status" className="text-xs text-[var(--text-tertiary)]">{t('documents.sharing.result_range', '{from}–{to} of {count}', { from: currentPage * PAGE_SIZE + 1, to: Math.min((currentPage + 1) * PAGE_SIZE, results.length), count: results.length })}</span>
                <div className="flex gap-1">
                    <button type="button" className={ICON_BUTTON} disabled={pending || currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label={t('documents.sharing.previous_page', 'Previous page')}><ChevronLeft size={16} aria-hidden="true" /></button>
                    <button type="button" className={ICON_BUTTON} disabled={pending || (currentPage + 1) * PAGE_SIZE >= results.length} onClick={() => setPage(currentPage + 1)} aria-label={t('documents.sharing.next_page', 'Next page')}><ChevronRight size={16} aria-hidden="true" /></button>
                </div>
            </div>}
        </div>
        {empty && <p className="text-xs text-[var(--text-secondary)]">{t('documents.sharing.choose_recipient', 'Choose at least one user or group.')}</p>}
    </section>;
}

function nextTab(key: string, current: Tab): Tab | null {
    const index = TABS.indexOf(current);
    if (key === 'ArrowRight') return TABS[(index + 1) % TABS.length];
    if (key === 'ArrowLeft') return TABS[(index + TABS.length - 1) % TABS.length];
    if (key === 'Home') return TABS[0];
    if (key === 'End') return TABS[TABS.length - 1];
    return null;
}

function RecipientIcon({ kind }: { kind: Recipient['kind'] }) {
    const Icon = kind === 'groups' ? UsersRound : UserRound;
    return <Icon size={14} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />;
}

function RecipientChip({ recipient: p, pending, toggle }: { recipient: Recipient; pending: boolean; toggle: Props['toggle'] }) {
    const { t } = useTranslation();
    return <button type="button" disabled={pending} aria-label={t('documents.sharing.remove', 'Remove {name}', { name: p.name })} onClick={() => toggle(p.field, p.id)}
        className="flex items-center gap-1.5 max-w-[160px] rounded-full border border-[var(--border-default)] bg-[var(--bg-card)] px-2 py-1 text-xs hover:bg-[var(--item-hover-bg)]">
        <RecipientIcon kind={p.kind} /><span className="truncate" title={p.name}>{p.name}</span><X size={12} aria-hidden="true" className="shrink-0" />
    </button>;
}

function RecipientResults({ recipients, selectedTab, pending, toggle }: { recipients: Recipient[]; selectedTab: boolean; pending: boolean; toggle: Props['toggle'] }) {
    const { t } = useTranslation();
    if (!recipients.length) return <p className="p-4 text-sm text-[var(--text-secondary)]">{selectedTab ? t('documents.sharing.no_selected_results', 'No selected recipients match your search.') : t('documents.sharing.no_results', 'No recipients found.')}</p>;
    return <ul className="divide-y divide-[var(--border-subtle)]">
        {recipients.map((p) => <li key={`${p.kind}:${p.id}`}>
            <label className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer text-sm hover:bg-[var(--item-hover-bg)] ${p.selected ? 'bg-[color-mix(in_srgb,var(--accent-primary)_6%,transparent)]' : ''}`}>
                <input type="checkbox" checked={p.selected} disabled={pending} onChange={() => toggle(p.field, p.id)} className="shrink-0 accent-[var(--accent-primary)]" />
                <RecipientIcon kind={p.kind} /><span className="truncate flex-1" title={p.name}>{p.name}</span>
                {selectedTab && <span className="text-xs text-[var(--text-tertiary)]">{p.kind === 'groups' ? t('documents.sharing.groups', 'Groups') : t('documents.sharing.users', 'Users')}</span>}
            </label>
        </li>)}
    </ul>;
}

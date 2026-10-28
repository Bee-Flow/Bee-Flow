import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import type { CatalogEntry } from './useLanguages';
import { useTranslation } from '@/hooks/useTranslation';
import Modal from '../../shared/Modal';

const FIELD_STYLE = { borderColor: 'var(--border-default)', color: 'var(--text-primary)', outline: 'none' };

interface AddLanguageModalProps {
    available: CatalogEntry[];
    onAdd: (code: string, name: string) => void;
    onClose: () => void;
}

/**
 * Pick a catalogue language or add a custom one. Through the shared Modal:
 * Escape and a press on the backdrop close it, Tab stays inside. The search
 * field is the first control, so Modal's initial focus lands where autoFocus
 * put it.
 */
export default function AddLanguageModal({ available, onAdd, onClose }: AddLanguageModalProps) {
    const { t } = useTranslation();
    const titleId = useId();
    const [search, setSearch] = useState('');
    const [customCode, setCustomCode] = useState('');
    const [customName, setCustomName] = useState('');

    const filtered = available.filter(l =>
        l.name.toLowerCase().includes(search.toLowerCase()) ||
        l.code.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <Modal open onClose={onClose} variant="bare" size="md" labelledBy={titleId}>
            <div className="w-full rounded-2xl border shadow-2xl p-5 bg-[var(--bg-secondary)] border-[var(--border-default)]">
                <h3 id={titleId} className="text-lg font-semibold mb-3 text-[var(--text-primary)]">{t('admin_languages.add_language', 'Add Language')}</h3>

                <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                    <input
                        value={search} onChange={e => setSearch(e.target.value)}
                        placeholder={t('admin_languages.search_languages', 'Search languages...')}
                        className="w-full pl-9 pr-3 py-2 rounded-lg text-sm border bg-[var(--bg-primary)]"
                        style={FIELD_STYLE}
                        autoFocus
                    />
                </div>

                <div className="max-h-56 overflow-y-auto space-y-1 mb-4 [scrollbar-width:thin]">
                    {filtered.map(l => (
                        <button key={l.code} onClick={() => onAdd(l.code, l.name)} className="w-full px-3 py-2 rounded-lg text-left text-sm flex items-center justify-between hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-primary)]">
                            <span>{l.name}</span>
                            <span className="text-xs text-[var(--text-muted)]">{l.code}</span>
                        </button>
                    ))}
                    {filtered.length === 0 && (
                        <p className="text-xs text-center py-4 text-[var(--text-muted)]">{t('admin_languages.no_match_languages', 'No matching languages. Use custom below.')}</p>
                    )}
                </div>

                <div className="border-t pt-3 mt-2 border-[var(--border-default)]">
                    <p className="text-xs font-medium mb-2 text-[var(--text-secondary)]">{t('admin_languages.or_custom', 'Or add custom:')}</p>
                    <div className="flex gap-2">
                        <input value={customCode} onChange={e => setCustomCode(e.target.value.toLowerCase())} placeholder={t('admin_languages.code_placeholder', 'Code (e.g. pt-br)')} className="w-24 px-2 py-1.5 rounded-lg text-sm border bg-[var(--bg-primary)]" style={FIELD_STYLE} />
                        <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder={t('admin_languages.name_placeholder', 'Language name')} className="flex-1 px-2 py-1.5 rounded-lg text-sm border bg-[var(--bg-primary)]" style={FIELD_STYLE} />
                        <button onClick={() => customCode && customName && onAdd(customCode, customName)} disabled={!customCode || !customName} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 bg-[var(--accent-primary)]">{t('admin_languages.add', 'Add')}</button>
                    </div>
                </div>

                <button onClick={onClose} className="mt-3 w-full py-2 rounded-lg text-sm font-medium border hover:bg-[var(--bg-tertiary)] transition-colors border-[var(--border-default)] text-[var(--text-secondary)]">{t('admin_languages.cancel', 'Cancel')}</button>
            </div>
        </Modal>
    );
}

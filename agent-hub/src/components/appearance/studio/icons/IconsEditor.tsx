import { Package, Plus, Trash2, Star, Download, Upload, AlertCircle, X } from 'lucide-react';
import React, { useState, useEffect, useCallback, useId } from 'react';
import { useIconPack } from '../../../../hooks/useIconPack';
import { useTranslation } from '../../../../hooks/useTranslation';
import { EMOJI_CATEGORIES as FALLBACK_CATEGORIES } from '../../../../utils/emojiCatalog';
import { authFetch } from '../../../../utils/helpers';
import Modal from '../../../shared/Modal';
import useConfirm from '../../../shared/useConfirm';
import type { AddPackModalProps, IconCategory, IconPack, PackListItemProps } from './IconsEditor.types';
import { mutate, ApiError, request, RefusedError } from '../../../../api/mutate';
import { API, PackEditor } from './PackEditor';

/**
 * IconsEditor — icon-pack management. Moved verbatim from the old
 * `admin/appearance/IconsSubPanel.jsx`; only the import paths and the export
 * name changed. Lives under the new Appearance shell as the second top-level
 * tab so its asset-management UX isn't tangled with the theme-token editor.
 */
export default function IconsEditor() {
    const { t } = useTranslation();
    const iconPackContext = useIconPack();

    const [packs, setPacks] = useState<IconPack[]>([]);
    const [activePackId, setActivePackId] = useState<string | null>(null);
    const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
    const [categories, setCategories] = useState<IconCategory[]>(FALLBACK_CATEGORIES);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showAddModal, setShowAddModal] = useState(false);
    const { confirm, confirmDialog } = useConfirm();

    const fetchPacks = useCallback(async () => {
        try {
            const res = await authFetch(API);
            const data = await res.json();
            setPacks(data.packs || []);
            setActivePackId(data.activeIconPackId || null);
            if (Array.isArray(data.categories) && data.categories.length) setCategories(data.categories);
            setSelectedPackId((prev: string | null) => {
                if (prev && data.packs?.some((p: IconPack) => p.id === prev)) return prev;
                return data.activeIconPackId || data.packs?.[0]?.id || null;
            });
        } catch {
            setError('Failed to load icon packs');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchPacks(); }, [fetchPacks]);

    const handleCreatePack = async (name: string) => {
        if (!name?.trim()) return;
        try {
            const res = await mutate(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), icons: {} }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                const newPack = await res.json();
                await fetchPacks();
                setSelectedPackId(newPack.id);
                setShowAddModal(false);
            } else {
                setError('Failed to create pack');
            }
        } catch {
            setError('Failed to create pack');
        }
    };

    const handleActivatePack = async (id: string | null) => {
        try { // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
            const res = await mutate(`${API}/${id || 'default'}/activate`, { method: 'POST' }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setActivePackId(id);
                iconPackContext.setIconPack(id);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleDeletePack = async (id: string) => {
        if (!(await confirm({ title: 'Delete this icon pack?', description: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true }))) return;
        try { // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
            const res = await mutate(`${API}/${id}`, { method: 'DELETE' }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                if (activePackId === id) {
                    setActivePackId(null);
                    iconPackContext.setIconPack(null);
                }
                if (selectedPackId === id) setSelectedPackId(null);
                fetchPacks();
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleExport = async (id: string) => {
        try {
            let res: Response;
            try {
                res = await request(`${API}/${id}/export`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                throw new Error('export failed');
            }
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `beeflow-iconpack-${(data.name || 'pack').replace(/[^a-z0-9]/gi, '_')}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            setError('Export failed');
        }
    };

    const handleImport = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                let res: Response;
                try {
                    res = await mutate(`${API}/import`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error('import failed');
                }
                const newPack = await res.json();
                await fetchPacks();
                setSelectedPackId(newPack.id);
            } catch {
                setError('Import failed — invalid JSON file');
            }
        };
        input.click();
    };

    const updatePackLocally = (id: string, partial: Partial<IconPack>) => {
        setPacks((prev: IconPack[]) => prev.map((p: IconPack) => p.id === id ? { ...p, ...partial } : p));
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
                {t('appearance.icons_editor_loading_icon_packs', 'Loading icon packs...')}
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
            {error && (
                <div className="mx-4 mt-3 px-3 py-2 rounded-lg text-sm flex items-center gap-2 [background:rgba(239,68,68,0.1)] [color:#ef4444]!">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                    <button onClick={() => setError('')} className="ml-auto" aria-label={t('appearance.icons_editor_dismiss_error', 'Dismiss error')}><X className="w-3.5 h-3.5" /></button>
                </div>
            )}

            <div className="flex flex-1 overflow-hidden">
                <div className="w-64 border-r shrink-0 flex flex-col border-[var(--border-default)] bg-[var(--bg-secondary)]">
                    <div className="p-3 border-b flex items-center justify-between border-[var(--border-default)]">
                        <span className="text-sm font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                            <Package className="w-4 h-4 text-[var(--accent-primary)]" />
                            {t('admin.tab_appearance', 'Icon Packs')}
                        </span>
                        <div className="flex items-center gap-0.5">
                            <button onClick={handleImport} className="p-1 rounded-md transition-colors hover:bg-[var(--bg-tertiary)]" title={t('appearance.icons_editor_import_pack', 'Import pack')} aria-label={t('appearance.icons_editor_import_pack', 'Import pack')}>
                                <Upload className="w-4 h-4 text-[var(--text-secondary)]" />
                            </button>
                            <button onClick={() => setShowAddModal(true)} className="p-1 rounded-md transition-colors hover:bg-[var(--bg-tertiary)]" title={t('appearance.icons_editor_new_pack', 'New pack')} aria-label={t('appearance.icons_editor_new_pack', 'New pack')}>
                                <Plus className="w-4 h-4 text-[var(--text-secondary)]" />
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        <PackListItem
                            label="System Default"
                            sub="Standard Lucide icons"
                            isActive={!activePackId}
                            isSelected={false}
                            onSelect={() => handleActivatePack(null)}
                        />

                        {packs.map((pack: IconPack) => (
                            <PackListItem
                                key={pack.id}
                                label={pack.name}
                                sub={`${Object.keys(pack.icons || {}).length} custom`}
                                isActive={activePackId === pack.id}
                                isSelected={selectedPackId === pack.id}
                                onSelect={() => setSelectedPackId(pack.id)}
                                onActivate={() => handleActivatePack(pack.id)}
                                onExport={() => handleExport(pack.id)}
                                onDelete={() => handleDeletePack(pack.id)}
                            />
                        ))}

                        {packs.length === 0 && (
                            <p className="text-xs text-center py-6 text-[var(--text-muted)]">
                                {t('appearance.icons_editor_no_custom_packs_yet_click_to_create', 'No custom packs yet — click + to create one.')}
                            </p>
                        )}
                    </div>
                </div>

                <div className="flex-1 flex flex-col overflow-hidden">
                    {selectedPackId ? (
                        <PackEditor
                            key={selectedPackId}
                            packId={selectedPackId}
                            categories={categories}
                            isActive={activePackId === selectedPackId}
                            onActivate={() => handleActivatePack(selectedPackId)}
                            onExport={() => handleExport(selectedPackId)}
                            onPackChanged={(partial: Partial<IconPack>) => {
                                updatePackLocally(selectedPackId, partial);
                                if (selectedPackId === activePackId) iconPackContext.reload();
                            }}
                        />
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
                            <div className="text-center">
                                <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
                                <p className="text-sm">{t('appearance.icons_editor_select_a_pack_to_edit_or_create_a_new', 'Select a pack to edit, or create a new one.')}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {showAddModal && (
                <AddPackModal onAdd={handleCreatePack} onClose={() => setShowAddModal(false)} />
            )}
            {confirmDialog}
        </div>
    );
}

const PackListItem = ({ label, sub, isActive, isSelected, onSelect, onActivate, onExport, onDelete }: PackListItemProps) => {
    const { t } = useTranslation();
    const isHighlight = isSelected;
    return (
        <div
            onClick={onSelect}
            className={`group px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between transition-all ${isHighlight ? 'bg-[var(--accent-primary)]' : 'hover:bg-[var(--bg-tertiary)]'}`}
            style={isHighlight ? { color: 'var(--accent-primary-fg, #ffffff)' } : undefined}
        >
            <div className="flex items-center gap-2 min-w-0">
                <Package className={`w-3.5 h-3.5 shrink-0 ${isHighlight ? '' : 'opacity-60'}`} />
                <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{label}</div>
                    <div className={`text-[10px] truncate ${isHighlight ? 'opacity-80' : 'opacity-60'}`}>{sub}</div>
                </div>
                {isActive && (
                    <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium ml-1 shrink-0"
                        style={{
                            background: isHighlight ? 'rgba(255,255,255,0.2)' : 'var(--accent-primary)',
                            color: 'var(--accent-primary-fg, #ffffff)',
                        }}
                    >
                        {t('appearance.icons_editor_active', 'Active')}
                    </span>
                )}
            </div>
            {(onActivate || onExport || onDelete) && (
                <div className={`flex items-center gap-0.5 shrink-0 ${isHighlight ? 'opacity-80' : 'opacity-0 group-hover:opacity-60'} transition-opacity`}>
                    {onActivate && !isActive && (
                        <button onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onActivate(); }} className="p-1 rounded hover:bg-black/10" title={t('appearance.icons_editor_set_as_active', 'Set as active')} aria-label={t('appearance.icons_editor_set_as_active', 'Set as active')}>
                            <Star className="w-3 h-3" />
                        </button>
                    )}
                    {onExport && (
                        <button onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onExport(); }} className="p-1 rounded hover:bg-black/10" title={t('appearance.icons_editor_export', 'Export')} aria-label={t('appearance.icons_editor_export', 'Export')}>
                            <Download className="w-3 h-3" />
                        </button>
                    )}
                    {onDelete && (
                        <button onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onDelete(); }} className="p-1 rounded hover:bg-red-500/20" title={t('appearance.icons_editor_delete', 'Delete')} aria-label={t('appearance.icons_editor_delete', 'Delete')}>
                            <Trash2 className="w-3 h-3" />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

// Both dialogs in this file go through the shared Modal: Escape and a press on
// the backdrop close them (the backdrop did before), Tab stays inside, focus
// returns to the button that opened them.
const AddPackModal = ({ onAdd, onClose }: AddPackModalProps) => {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const titleId = useId();
    return (
        <Modal open onClose={onClose} variant="bare" size="sm" labelledBy={titleId}>
            <div className="w-full rounded-2xl border shadow-2xl p-5 [background:var(--bg-secondary)] [border-color:var(--border-default)]" data-surface="opaque">
                <h3 id={titleId} className="text-lg font-semibold mb-3 text-[var(--text-primary)]">{t('appearance.icons_editor_new_icon_pack', 'New Icon Pack')}</h3>
                <input
                    autoFocus
                    value={name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') onAdd(name); }}
                    placeholder={t('appearance.icons_editor_pack_name', 'Pack name')}
                    className="w-full px-3 py-2 rounded-lg text-sm border bg-[var(--bg-primary)] mb-4 [border-color:var(--border-default)] [color:var(--text-primary)]! [outline:none]"
                />
                <div className="flex gap-2">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm font-medium border hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)]">
                        {t('appearance.icons_editor_cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={() => onAdd(name)}
                        disabled={!name.trim()}
                        className="flex-1 py-2 rounded-lg text-sm font-medium disabled:opacity-40 [background:var(--accent-primary)] [color:var(--accent-primary-fg,#ffffff)]!"
                    >
                        {t('appearance.icons_editor_create', 'Create')}
                    </button>
                </div>
            </div>
        </Modal>
    );
};


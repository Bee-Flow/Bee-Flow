import { Package, Plus, Trash2, Download, Upload, AlertCircle, X } from 'lucide-react';
import React, { useState, useCallback, useId } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { iconPackKeys, useIconPackListQuery, type IconPackList } from '@/api/queries/iconPacks';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { useIconPack } from '@/hooks/useIconPack';
import { TranslateParams, useTranslation } from '@/hooks/useTranslation';
import { EMOJI_CATEGORIES as FALLBACK_CATEGORIES } from '@/utils/emojiCatalog';
import Modal from '@/components/shared/Modal';
import useConfirm from '@/components/shared/useConfirm';
import type { AddPackModalProps, IconCategory, IconPack, PackListItemProps } from './IconsEditor.types';
import { ApiError, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import { PackEditor } from './PackEditor';
import { ALERT_ERROR, CHIP, INPUT, PRIMARY_BTN, SECONDARY_BTN } from '@/components/shared/adminUi';

const NO_PACKS: IconPack[] = [];

/**
 * The pack list (one read on mount, again after a change), the active and the
 * selected pack (both follow each answer), and the error line.
 */
function useIconPackList(loadFailed: string) {
    const packsQuery = useIconPackListQuery<IconPack, IconCategory>();
    const qc = useQueryClient();
    const listed = packsQuery.data;
    const packs = listed?.packs || NO_PACKS;
    const categories = Array.isArray(listed?.categories) && listed.categories.length ? listed.categories : FALLBACK_CATEGORIES;
    // The pack in use follows each answer; deleting it clears it at once.
    const [activePackId, setActivePackId] = useState<string | null>(null);
    const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
    useAdjustOnChange([listed], () => {
        if (!listed) return;
        setActivePackId(listed.activeIconPackId || null);
        setSelectedPackId((prev: string | null) => {
            if (prev && listed.packs?.some((p: IconPack) => p.id === prev)) return prev;
            return listed.activeIconPackId || listed.packs?.[0]?.id || null;
        });
    });
    const loading = packsQuery.isPending;
    const [error, setError] = useState('');
    useAdjustOnChange([packsQuery.errorUpdatedAt], () => { if (packsQuery.isError) setError(loadFailed); });
    const refetchPacks = packsQuery.refetch;
    const fetchPacks = useCallback(async () => { await refetchPacks(); }, [refetchPacks]);

    const updatePackLocally = (id: string, partial: Partial<IconPack>) => {
        qc.setQueryData<IconPackList<IconPack, IconCategory>>(iconPackKeys.list(), (prev) => prev && {
            ...prev,
            packs: (prev.packs || []).map((p: IconPack) => p.id === id ? { ...p, ...partial } : p),
        });
    };

    return {
        packs, categories, loading, error, setError, activePackId, setActivePackId,
        selectedPackId, setSelectedPackId, fetchPacks, updatePackLocally,
    };
}

/**
 * IconsEditor — icon-pack authoring (Whole server > Appearance > Icon packs):
 * create, edit, generate, import, export and delete packs. A pack belongs to
 * the person who made it, and choosing the pack you USE is a personal setting:
 * it lives in Settings > Appearance (pages/settings/IconPackChoice), next to
 * the theme. The list here only marks the pack in use.
 */
export default function IconsEditor() {
    const { t } = useTranslation();
    const iconPackContext = useIconPack();

    const {
        packs, categories, loading, error, setError, activePackId, setActivePackId,
        selectedPackId, setSelectedPackId, fetchPacks, updatePackLocally,
    } = useIconPackList(t('platform_panels.icon_packs_load_failed', 'Could not load the icon packs.'));
    const [showAddModal, setShowAddModal] = useState(false);
    const { confirm, confirmDialog } = useConfirm();

    const handleCreatePack = async (name: string) => {
        if (!name?.trim()) return;
        try {
            const res = await apiRequest('POST /api/icons', { body: { name: name.trim(), icons: {} } }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                const newPack = await res.json();
                await fetchPacks();
                setSelectedPackId(newPack.id);
                setShowAddModal(false);
            } else {
                setError(t('platform_panels.icon_packs_create_failed', 'Could not create the pack.'));
            }
        } catch {
            setError(t('platform_panels.icon_packs_create_failed', 'Could not create the pack.'));
        }
    };

    const handleDeletePack = async (id: string) => {
        if (!(await confirm({ title: t('platform_panels.icon_packs_delete_title', 'Delete this icon pack?'), description: t('platform_panels.icon_packs_delete_body', 'This cannot be undone.'), confirmLabel: t('appearance.icons_editor_delete', 'Delete'), destructive: true }))) return;
        try { // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
            const res = await apiRequest('DELETE /api/icons/{id}', { params: { id } }).catch((err: unknown) => {
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
                res = await apiRequest('GET /api/icons/{id}/export', { params: { id } });
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
            setError(t('platform_panels.icon_packs_export_failed', 'Could not export the pack.'));
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
                    res = await apiRequest('POST /api/icons/import', { body: data });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error('import failed');
                }
                const newPack = await res.json();
                await fetchPacks();
                setSelectedPackId(newPack.id);
            } catch {
                setError(t('platform_panels.icon_packs_import_failed', 'Could not import the pack: the file is not valid JSON.'));
            }
        };
        input.click();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full text-[var(--text-tertiary)]">
                {t('appearance.icons_editor_loading_icon_packs', 'Loading icon packs...')}
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
            {error && (
                <div className={`mx-4 mt-3 ${ALERT_ERROR}`}>
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                    <button type="button" onClick={() => setError('')} className="ml-auto" aria-label={t('appearance.icons_editor_dismiss_error', 'Dismiss error')}><X className="w-3.5 h-3.5" /></button>
                </div>
            )}

            <div className="flex flex-1 overflow-hidden">
                <IconsEditorSection t={t} handleImport={handleImport} setShowAddModal={setShowAddModal} activePackId={activePackId} packs={packs} selectedPackId={selectedPackId} setSelectedPackId={setSelectedPackId} handleExport={handleExport} handleDeletePack={handleDeletePack} />

                <div className="flex-1 flex flex-col overflow-hidden">
                    {selectedPackId ? (
                        <PackEditor
                            key={selectedPackId}
                            packId={selectedPackId}
                            categories={categories}
                            isActive={activePackId === selectedPackId}
                            onExport={() => handleExport(selectedPackId)}
                            onPackChanged={(partial: Partial<IconPack>) => {
                                updatePackLocally(selectedPackId, partial);
                                if (selectedPackId === activePackId) iconPackContext.reload();
                            }}
                        />
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-[var(--text-tertiary)]">
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

const PackListItem = ({ label, sub, isActive, isSelected, onSelect, onExport, onDelete }: PackListItemProps) => {
    const { t } = useTranslation();
    const isHighlight = isSelected;
    return (
        <div
            className={`group px-3 py-2 rounded-md flex items-center justify-between transition-all ${isHighlight ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'}`}
        >
            <button type="button" onClick={onSelect} aria-current={isSelected ? 'true' : undefined} className="flex flex-1 items-center gap-2 min-w-0 text-left">
                <Package className={`w-3.5 h-3.5 shrink-0 ${isHighlight ? '' : 'opacity-60'}`} aria-hidden="true" />
                <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{label}</span>
                    <span className={`block text-[10px] truncate ${isHighlight ? 'opacity-80' : 'opacity-60'}`}>{sub}</span>
                </span>
                {isActive && (
                    <span className={`ml-1 ${CHIP}`}>
                        {t('platform_panels.icon_packs_in_use', 'In use by you')}
                    </span>
                )}
            </button>
            {(onExport || onDelete) && (
                <div className={`flex items-center gap-0.5 shrink-0 ${isHighlight ? 'opacity-80' : 'opacity-0 group-hover:opacity-60 group-focus-within:opacity-80'} transition-opacity`}>
                    {onExport && (
                        <button type="button" onClick={onExport} className="p-1 rounded hover:bg-[var(--item-hover-bg)]" title={t('appearance.icons_editor_export', 'Export')} aria-label={t('appearance.icons_editor_export', 'Export')}>
                            <Download className="w-3 h-3" />
                        </button>
                    )}
                    {onDelete && (
                        <button type="button" onClick={onDelete} className="p-1 rounded text-[var(--error-ink)] hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]" title={t('appearance.icons_editor_delete', 'Delete')} aria-label={t('appearance.icons_editor_delete', 'Delete')}>
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
            <div className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-5 shadow-2xl" data-surface="opaque">
                <h3 id={titleId} className="text-lg font-semibold mb-3 text-[var(--text-primary)]">{t('appearance.icons_editor_new_icon_pack', 'New Icon Pack')}</h3>
                <input
                    autoFocus
                    value={name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') onAdd(name); }}
                    placeholder={t('appearance.icons_editor_pack_name', 'Pack name')}
                    className={`${INPUT} mb-4`}
                />
                <div className="flex gap-2">
                    <button type="button" onClick={onClose} className={`${SECONDARY_BTN} flex-1`}>
                        {t('appearance.icons_editor_cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onAdd(name)}
                        disabled={!name.trim()}
                        className={`${PRIMARY_BTN} flex-1`}
                    >
                        {t('appearance.icons_editor_create', 'Create')}
                    </button>
                </div>
            </div>
        </Modal>
    );
};


function IconsEditorSection({ t, handleImport, setShowAddModal, activePackId, packs, selectedPackId, setSelectedPackId, handleExport, handleDeletePack }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; handleImport: () => void; setShowAddModal: React.Dispatch<React.SetStateAction<boolean>>; activePackId: string | null; packs: IconPack[]; selectedPackId: string | null; setSelectedPackId: React.Dispatch<React.SetStateAction<string | null>>; handleExport: (id: string) => Promise<void>; handleDeletePack: (id: string) => Promise<void>; }) {
    return <div className="w-64 border-r shrink-0 flex flex-col border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <div className="p-3 border-b flex items-center justify-between border-[var(--border-default)]">
            <span className="text-sm font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                <Package className="w-4 h-4 text-[var(--text-secondary)]" aria-hidden="true" />
                {t('admin_nav.icon_packs', 'Icon packs')}
            </span>
            <div className="flex items-center gap-0.5">
                <button type="button" onClick={handleImport} className="p-1 rounded-md transition-colors hover:bg-[var(--bg-tertiary)]" title={t('appearance.icons_editor_import_pack', 'Import pack')} aria-label={t('appearance.icons_editor_import_pack', 'Import pack')}>
                    <Upload className="w-4 h-4 text-[var(--text-secondary)]" />
                </button>
                <button type="button" onClick={() => setShowAddModal(true)} className="p-1 rounded-md transition-colors hover:bg-[var(--bg-tertiary)]" title={t('appearance.icons_editor_new_pack', 'New pack')} aria-label={t('appearance.icons_editor_new_pack', 'New pack')}>
                    <Plus className="w-4 h-4 text-[var(--text-secondary)]" />
                </button>
            </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {packs.map((pack: IconPack) => (
                <PackListItem
                    key={pack.id}
                    label={pack.name}
                    sub={t('platform_panels.icon_packs_count', '{n} custom icons', { n: Object.keys(pack.icons || {}).length })}
                    isActive={activePackId === pack.id}
                    isSelected={selectedPackId === pack.id}
                    onSelect={() => setSelectedPackId(pack.id)}
                    onExport={() => handleExport(pack.id)}
                    onDelete={() => handleDeletePack(pack.id)} />
            ))}

            {packs.length === 0 && (
                <p className="text-xs text-center py-6 text-[var(--text-tertiary)]">
                    {t('appearance.icons_editor_no_custom_packs_yet_click_to_create', 'No custom packs yet — click + to create one.')}
                </p>
            )}
        </div>
        <p className="m-0 border-t border-[var(--border-default)] px-3 py-2 text-[11px] leading-snug text-[var(--text-tertiary)]">
            {t('platform_panels.icon_packs_choose_hint', 'Packs are yours. Pick the one you use in Settings > Appearance.')}
        </p>
    </div>;
}

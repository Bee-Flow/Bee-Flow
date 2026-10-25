import { Check, Pencil, Search, Download, AlertCircle, Loader2 } from 'lucide-react';
import React, { useState, useEffect, useCallback, useId, useMemo } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { loadSettings } from '../../../chat/NanoBananaSettings';
import IconPickerModal from '../../../icons/IconPickerModal';
import Modal from '../../../shared/Modal';
import useConfirm from '../../../shared/useConfirm';
import type { CustomIcon } from '../../../../hooks/useIconPack';
import type { BulkGenerateModalProps, BulkOptions, BulkResult, IconCategory, IconCellProps, IconEntry, IconPack, PackEditorProps } from './IconsEditor.types';
import { errorMessage } from '../../../../utils/caughtError';
import { logger } from '../../../../utils/logger';
import { mutate, ApiError } from '../../../../api/mutate';

export const API = `${API_BASE}/api/icons`;

export const PackEditor = ({ packId, categories, isActive, onActivate, onExport, onPackChanged }: PackEditorProps) => {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [pack, setPack] = useState<IconPack | null>(null);
    const [search, setSearch] = useState('');
    const [showOnly, setShowOnly] = useState('all');
    const [editingIconKey, setEditingIconKey] = useState<string | null>(null);
    const [nanoSettings] = useState(() => loadSettings());
    const [bulkOpen, setBulkOpen] = useState(false);
    const [bulkRunning, setBulkRunning] = useState(false);
    const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

    const fetchPack = useCallback(async () => {
        try {
            const res = await authFetch(API);
            const data = await res.json();
            setPack(data.packs?.find((p: IconPack) => p.id === packId) || null);
        } catch (err) { logger.debug('swallowed', err); }
    }, [packId]);

    useEffect(() => { fetchPack(); }, [fetchPack]);

    const allEntries = useMemo(() => categories.flatMap((c: IconCategory) => c.entries || []), [categories]);
    const stats = useMemo(() => {
        const total = allEntries.length;
        const customized = allEntries.filter((e: IconEntry) => (pack?.icons || {})[e.id]).length;
        return { total, customized, progress: total ? Math.round((customized / total) * 100) : 0 };
    }, [allEntries, pack]);

    const editingEntry = useMemo(
        () => allEntries.find((e: IconEntry) => e.id === editingIconKey) || null,
        [allEntries, editingIconKey]
    );

    const setIcon = useCallback(async (iconKey: string, iconData: CustomIcon | null) => {
        if (!pack) return;
        const optimistic = { ...(pack.icons || {}) };
        if (iconData === null) delete optimistic[iconKey];
        else optimistic[iconKey] = iconData;
        setPack((prev: IconPack | null) => prev ? { ...prev, icons: optimistic } : prev);
        onPackChanged({ icons: optimistic });

        try {
            const res = await authFetch(`${API}/${pack.id}/icons/${encodeURIComponent(iconKey)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(iconData || {}),
            });
            if (!res.ok) await fetchPack();
        } catch {
            await fetchPack();
        }
    }, [pack, onPackChanged, fetchPack]);

    const handleResetAll = async () => {
        if (!(await confirm({ title: 'Remove ALL custom icons from this pack?', confirmLabel: 'Remove all', destructive: true }))) return;
        try { // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
            const res = await mutate(`${API}/${(pack as IconPack).id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icons: {} }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setPack((prev: IconPack | null) => prev ? { ...prev, icons: {} } : prev);
                onPackChanged({ icons: {} });
            }
        } catch (e) {
            console.error(e);
        }
    };

    const runBulkGenerate = async ({ style, model, overwrite }: BulkOptions) => {
        setBulkRunning(true);
        setBulkResult(null);
        try {
            const res = await authFetch(`${API}/${(pack as IconPack).id}/bulk-generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ style, model, overwrite }),
            });
            const data = await res.json();
            if (res.ok) {
                setBulkResult({ ok: true, message: data.message });
                await fetchPack();
                onPackChanged({});
                setTimeout(() => setBulkResult(null), 8000);
            } else {
                setBulkResult({ ok: false, message: data.error || 'Failed' });
            }
        } catch (e) {
            setBulkResult({ ok: false, message: errorMessage(e) });
        }
        setBulkRunning(false);
    };

    if (!pack) {
        return <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">{t('appearance.icons_editor_loading_pack', 'Loading pack...')}</div>;
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center justify-between flex-wrap gap-3 shrink-0 border-[var(--border-default)]">
                <div className="min-w-0">
                    <h3 className="font-semibold text-base truncate text-[var(--text-primary)]">
                        {t('appearance.icons_editor_editing_name', 'Editing "{name}"', { name: pack.name })}
                    </h3>
                    <p className="text-xs mt-0.5 flex items-center gap-2 text-[var(--text-muted)]">
                        <span>{t('appearance.icons_editor_click_any_icon_to_customise_it', 'Click any icon to customise it.')}</span>
                        {isActive && (
                            <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase [background:color-mix(in_srgb,var(--accent-primary)_14%,transparent)] [color:var(--accent-primary)]!"
                            >
                                {t('appearance.icons_editor_active_preview', 'Active Preview')}
                            </span>
                        )}
                    </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <button
                        onClick={() => setBulkOpen(true)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-white flex items-center gap-1.5 transition-opacity [background:linear-gradient(135deg,#f59e0b,#ef4444)]"
                    >
                        {t('appearance.icons_editor_ai_generate_all', 'AI Generate All')}
                    </button>
                    <button onClick={onExport} className="px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)]">
                        <Download className="w-3.5 h-3.5" /> {t('appearance.icons_editor_export', 'Export')}
                    </button>
                    <button
                        onClick={handleResetAll}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border hover:text-[var(--danger,#ef4444)] [border-color:var(--border-default)] [color:var(--text-muted)]!"
                    >
                        {t('appearance.icons_editor_reset_all', 'Reset All')}
                    </button>
                    {!isActive && (
                        <button
                            onClick={onActivate}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium [background:var(--accent-primary)] [color:var(--accent-primary-fg,#ffffff)]!"
                        >
                            {t('appearance.icons_editor_set_as_active_2', 'Set as Active')}
                        </button>
                    )}
                </div>
            </div>

            <div className="px-4 py-3 flex items-center gap-3 shrink-0 flex-wrap">
                <div className="flex-1 min-w-48 h-2 rounded-full overflow-hidden bg-[var(--bg-tertiary)]">
                    <div className="h-full rounded-full transition-all" style={{ width: `${stats.progress}%`, background: stats.progress >= 100 ? '#22c55e' : 'var(--accent-primary)' }} />
                </div>
                <span className="text-xs font-medium shrink-0 text-[var(--text-secondary)]">
                    {stats.customized} / {stats.total} ({stats.progress}%)
                </span>
                <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                        value={search}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                        placeholder={t('appearance.icons_editor_search_icons', 'Search icons...')}
                        className="pl-7 pr-3 py-1.5 rounded-lg text-xs border bg-[var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline:none] w-[180px]"
                    />
                </div>
                <select
                    value={showOnly}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setShowOnly(e.target.value)}
                    className="px-2 py-1.5 rounded-lg text-xs border bg-[var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline:none]"
                >
                    <option value="all">{t('appearance.icons_editor_all_total', 'All ({total})', { total: stats.total })}</option>
                    <option value="customized">{t('appearance.icons_editor_customized_customized', 'Customized ({customized})', { customized: stats.customized })}</option>
                    <option value="missing">{t('appearance.icons_editor_default', 'Default (')}{stats.total - stats.customized})</option>
                </select>
            </div>

            {bulkResult && (
                <div className="mx-4 mb-2 px-3 py-2 rounded-lg text-xs flex items-center gap-2" style={{
                    background: bulkResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: bulkResult.ok ? '#22c55e' : '#ef4444',
                }}>
                    {bulkResult.ok ? <Check className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                    {bulkResult.message}
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-6">
                {categories.map((category: IconCategory) => {
                    const entries = category.entries || [];
                    const filtered = entries.filter((entry: IconEntry) => {
                        const q = search.toLowerCase();
                        if (q && !entry.id.toLowerCase().includes(q) && !(entry.label || '').toLowerCase().includes(q)) return false;
                        const isCustom = !!(pack.icons || {})[entry.id];
                        if (showOnly === 'customized' && !isCustom) return false;
                        if (showOnly === 'missing' && isCustom) return false;
                        return true;
                    });
                    if (filtered.length === 0) return null;
                    return (
                        <div key={category.name}>
                            <h4 className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--text-muted)]">
                                {category.name}
                            </h4>
                            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-2">
                                {filtered.map((entry: IconEntry) => (
                                    <IconCell
                                        key={entry.id}
                                        entry={entry}
                                        custom={(pack.icons || {})[entry.id]}
                                        onClick={() => setEditingIconKey(entry.id)}
                                    />
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            {editingEntry && (
                <IconPickerModal
                    isOpen
                    onClose={() => setEditingIconKey(null)}
                    iconKey={editingEntry.id}
                    iconLabel={editingEntry.label}
                    defaultEmoji={editingEntry.defaultEmoji}
                    currentCustom={(pack.icons || {})[editingEntry.id]}
                    nanoBananaSettings={nanoSettings}
                    onApply={(data: CustomIcon | null) => {
                        setIcon(editingEntry.id, data);
                        setEditingIconKey(null);
                    }}
                />
            )}

            {bulkOpen && (
                <BulkGenerateModal
                    pack={pack}
                    nanoSettings={nanoSettings}
                    running={bulkRunning}
                    onRun={async (opts: BulkOptions) => { await runBulkGenerate(opts); setBulkOpen(false); }}
                    onClose={() => setBulkOpen(false)}
                />
            )}
            {confirmDialog}
        </div>
    );
};

const IconCell = React.memo(({ entry, custom, onClick }: IconCellProps) => {
    const { t } = useTranslation();
    const display = custom
        ? (custom.type === 'image'
            ? <img src={custom.value} alt={entry.label} className="w-6 h-6 object-contain" />
            : <span className="text-xl leading-none">{custom.value}</span>)
        : <span className="text-xl leading-none [opacity:0.85]">{entry.defaultEmoji}</span>;

    return (
        <button
            onClick={onClick}
            title={entry.label}
            className="relative flex flex-col items-center justify-center p-2 border rounded-lg cursor-pointer transition-colors group"
            style={{
                background: custom ? 'rgba(59, 130, 246, 0.05)' : 'var(--bg-secondary)',
                borderColor: custom ? 'rgba(59, 130, 246, 0.4)' : 'var(--border-subtle)',
            }}
        >
            <div className="h-8 flex items-center justify-center mb-1">{display}</div>
            <span className="text-[10px] text-center w-full truncate px-1" style={{ color: custom ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {entry.label}
            </span>
            {custom && <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)]" title={t('appearance.icons_editor_customized', 'Customized')} />}
            <div className="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 flex items-center justify-center rounded-lg transition-opacity">
                <div className="p-1 rounded-full shadow-sm bg-[var(--bg-card)]">
                    <Pencil className="w-3 h-3 text-[var(--accent-primary)]" />
                </div>
            </div>
        </button>
    );
});

const BulkGenerateModal = ({ pack, nanoSettings, running, onRun, onClose }: BulkGenerateModalProps) => {
    const { t } = useTranslation();
    const [style, setStyle] = useState('flat 2D vector icon, single subject centred, solid background, no text, app-icon style');
    const [model, setModel] = useState(nanoSettings?.image?.model || 'gemini-3.1-flash-image-preview');
    const [overwrite, setOverwrite] = useState(false);
    const customCount = Object.keys(pack.icons || {}).length;
    const titleId = useId();
    return (
        <Modal open onClose={onClose} variant="bare" size="md" labelledBy={titleId}>
            <div className="w-full rounded-2xl border shadow-2xl p-5 [background:var(--bg-secondary)] [border-color:var(--border-default)]" data-surface="opaque">
                <div className="flex items-center gap-2 mb-3">
                    <h3 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">{t('appearance.icons_editor_ai_generate_all_emojis', 'AI Generate All Emojis')}</h3>
                </div>
                <p className="text-xs mb-4 text-[var(--text-muted)]">
                    {t('appearance.icons_editor_generates_an_icon_for_every_entry_in', 'Generates an icon for every entry in the catalog using Nano Banana. Existing custom overrides are kept unless you tick overwrite.')}
                </p>

                <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">{t('appearance.icons_editor_style_prompt', 'Style prompt')}</label>
                <textarea
                    value={style}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setStyle(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border text-xs mb-3 [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline:none]"
                />

                <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">{t('appearance.icons_editor_model', 'Model')}</label>
                <select
                    value={model}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setModel(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border text-xs mb-3 [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline:none]"
                >
                    <option value="gemini-3.1-flash-image-preview">{t('appearance.icons_editor_nano_banana_2_flash_fast', 'Nano Banana 2 — Flash (fast)')}</option>
                    <option value="gemini-3-pro-image-preview">{t('appearance.icons_editor_nano_banana_pro_quality', 'Nano Banana Pro — Quality')}</option>
                    <option value="gemini-2.5-flash-image">{t('appearance.icons_editor_nano_banana_2_5_flash', 'Nano Banana — 2.5 Flash')}</option>
                </select>

                <label className="flex items-center gap-2 text-xs mb-4 text-[var(--text-secondary)]">
                    <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
                    {t('appearance.icons_editor_overwrite_existing_customised_icons', 'Overwrite existing customised icons ({custom_count} currently set)', { custom_count: customCount })}
                </label>
                <div className="flex gap-2">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm font-medium border hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)]">
                        {t('appearance.icons_editor_cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={() => onRun({ style, model, overwrite })}
                        disabled={running}
                        className="flex-1 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 flex items-center justify-center gap-2 [background:linear-gradient(135deg,#f59e0b,#ef4444)]"
                    >
                        {running && <Loader2 className="w-4 h-4 animate-spin" />}
                        {running ? 'Generating...' : 'Generate'}
                    </button>
                </div>
            </div>
        </Modal>
    );
};

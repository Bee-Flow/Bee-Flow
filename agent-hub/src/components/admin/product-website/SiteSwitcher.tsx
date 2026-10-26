import React, { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import useOutsideDismiss from '@/hooks/useOutsideDismiss';
import AppIcon from '../../icons/AppIcon';
import { useTranslation } from '@/hooks/useTranslation';
import type { CmsSiteListEntry } from './panel/cmsPanelTypes';

interface SiteSwitcherProps {
    sites: CmsSiteListEntry[];
    activeSiteId?: string | null;
    liveSiteId?: string | null;
    onSelect: (siteId: string) => void;
    onCreate: (name: string) => Promise<{ id?: string } | null> | void;
    onRename: (siteId: string, name: string) => Promise<unknown> | void;
    onDelete: (site: CmsSiteListEntry) => Promise<unknown> | void;
    embedded?: boolean;
}

/**
 * Site/project switcher.
 *
 * Standalone (default): a trigger button + popover listing every site, each
 * with a hover row-menu (Rename / Delete) plus a "+ New site" footer.
 * Embedded (`embedded` prop): renders ONLY the list + create footer, for
 * hosts that already provide the trigger/popover (the builder TopBar's
 * SiteVersionMenu).
 *
 * All API calls are owned by the parent (ProductWebsitePanel). This
 * component just renders + dispatches handler props. Deleting is NOT
 * confirmed here — `onDelete(site)` receives the full site object and the
 * parent asks for confirmation (one dialog system shell-wide).
 */
export default function SiteSwitcher({
    sites,
    activeSiteId,
    liveSiteId,
    onSelect,
    onCreate,
    onRename,
    onDelete,
    embedded = false,
}: SiteSwitcherProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    const activeSite = sites.find(s => s.id === activeSiteId);

    // Click-outside to close.
    useOutsideDismiss(rootRef, () => {
        setOpen(false);
        setCreating(false);
        setRenamingId(null);
    }, { enabled: open, escape: false, defer: false });

    const handlePick = (siteId: string) => {
        if (siteId !== activeSiteId) onSelect(siteId);
        setOpen(false);
    };

    const handleCreateConfirm = async (name: string) => {
        const created = await onCreate(name);
        setCreating(false);
        if (created?.id) {
            setOpen(false);
        }
    };

    const handleRenameConfirm = async (siteId: string, name: string) => {
        await onRename(siteId, name);
        setRenamingId(null);
    };

    // Confirmation is the parent's job (shared ConfirmDialog); we pass the
    // full site object so the dialog can name what's being deleted.
    const handleDelete = async (site: CmsSiteListEntry) => {
        await onDelete(site);
    };

    const listAndFooter = (
        <>
            {/* Site list */}
            <ul className="max-h-72 overflow-y-auto py-1">
                {sites.length === 0 && (
                    <li className="px-3 py-2 text-xs text-[var(--text-muted)] italic">
                        {t('cms_site.site.siteswitcher.no_sites', 'No sites yet')}
                    </li>
                )}
                {sites.map(site => (
                    <SiteRow
                        key={site.id}
                        site={site}
                        isActive={site.id === activeSiteId}
                        isLive={site.id === liveSiteId}
                        isRenaming={renamingId === site.id}
                        onPick={() => handlePick(site.id)}
                        onStartRename={() => setRenamingId(site.id)}
                        onCancelRename={() => setRenamingId(null)}
                        onConfirmRename={(name) => handleRenameConfirm(site.id, name)}
                        onDelete={() => handleDelete(site)}
                    />
                ))}
            </ul>

            {/* Create footer */}
            <div className="border-t border-[var(--border-subtle)]">
                {creating ? (
                    <CreateSiteForm
                        onConfirm={handleCreateConfirm}
                        onCancel={() => setCreating(false)}
                    />
                ) : (
                    <button
                        type="button"
                        onClick={() => setCreating(true)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--accent-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                    >
                        <AppIcon name="Plus" className="w-3.5 h-3.5" />
                        {t('cms_site.site.siteswitcher.new_site', 'New site')}
                    </button>
                )}
            </div>
        </>
    );

    if (embedded) return listAndFooter;

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-sm text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60 transition-colors"
                title={t('cms_site.site.siteswitcher.switch_site', 'Switch site')}
            >
                <span className="flex items-center gap-2 min-w-0">
                    <AppIcon name="Globe" className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate font-medium">
                        {activeSite ? activeSite.name : t('cms_site.site.siteswitcher.select_site', 'Select a site')}
                    </span>
                    {activeSite && activeSite.id === liveSiteId && (
                        <span
                            className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"
                            title={t('cms_site.site.siteswitcher.this_live', 'This site is live')}
                        />
                    )}
                </span>
                <AppIcon name={open ? 'ChevronUp' : 'ChevronDown'} className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
            </button>

            {open && (
                <div
                    className="absolute z-30 mt-1 left-0 right-0 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-lg overflow-hidden min-w-[220px]"
                >
                    {listAndFooter}
                </div>
            )}
        </div>
    );
}

// ── Row with hover menu + inline rename ─────────────────────────

interface SiteRowProps {
    site: CmsSiteListEntry;
    isActive: boolean;
    isLive: boolean;
    isRenaming: boolean;
    onPick: () => void;
    onStartRename: () => void;
    onCancelRename: () => void;
    onConfirmRename: (name: string) => void;
    onDelete: () => void;
}

function SiteRow({ site, isActive, isLive, isRenaming, onPick, onStartRename, onCancelRename, onConfirmRename, onDelete }: SiteRowProps) {
    const { t } = useTranslation();
    if (isRenaming) {
        return (
            <li>
                <RenameInline
                    initial={site.name}
                    onConfirm={onConfirmRename}
                    onCancel={onCancelRename}
                />
            </li>
        );
    }
    return (
        <li className="group">
            <div
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm
                    ${isActive
                        ? 'bg-[var(--accent-primary)]/10 text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                onClick={onPick}
            >
                <AppIcon
                    name={isActive ? 'Check' : 'Globe'}
                    className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'}`}
                />
                <span className="truncate flex-1">{site.name}</span>
                {isLive && (
                    <span
                        className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-[10px] font-medium text-emerald-400"
                        title={t('cms_site.site.siteswitcher.currently_live', 'Currently live at the public URL')}
                    >
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        {t('cms_site.site.siteswitcher.live', 'Live')}
                    </span>
                )}
                <span className="opacity-40 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                    <IconBtn name="Pencil" title={t('cms_site.site.siteswitcher.rename', 'Rename')} onClick={(e: MouseEvent) => { e.stopPropagation(); onStartRename(); }} />
                    <IconBtn name="Trash2" title={t('cms_site.site.siteswitcher.delete', 'Delete')} danger onClick={(e: MouseEvent) => { e.stopPropagation(); onDelete(); }} />
                </span>
            </div>
        </li>
    );
}

interface IconBtnProps {
    name: string;
    title: string;
    onClick: (e: MouseEvent) => void;
    danger?: boolean;
}

function IconBtn({ name, title, onClick, danger }: IconBtnProps) {
    return (
        <button
            type="button"
            title={title}
            onClick={onClick}
            className={`p-1 rounded hover:bg-[var(--bg-primary)]
                ${danger ? 'text-[var(--text-muted)] hover:text-red-400' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
        >
            <AppIcon name={name} className="w-3 h-3" />
        </button>
    );
}

// ── Inline rename input ─────────────────────────────────────────

interface RenameInlineProps {
    initial?: string;
    onConfirm: (name: string) => void;
    onCancel: () => void;
}

function RenameInline({ initial, onConfirm, onCancel }: RenameInlineProps) {
    const { t } = useTranslation();
    const [name, setName] = useState(initial || '');
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

    const submit = () => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === initial) { onCancel(); return; }
        onConfirm(trimmed);
    };

    return (
        <div className="flex items-center gap-1 px-2 py-1.5 bg-[var(--bg-tertiary)]">
            <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') onCancel();
                }}
                className="flex-1 px-2 py-1 rounded text-xs border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
            <button
                type="button"
                onClick={submit}
                className="text-xs text-[var(--accent-primary)] hover:text-[var(--accent-primary)]/80 px-1"
            >
                {t('cms_site.site.siteswitcher.save', 'Save')}
            </button>
            <button
                type="button"
                onClick={onCancel}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
            >
                {t('cms_site.site.siteswitcher.cancel', 'Cancel')}
            </button>
        </div>
    );
}

// ── Create-site inline form ─────────────────────────────────────

interface CreateSiteFormProps {
    onConfirm: (name: string) => void;
    onCancel: () => void;
}

function CreateSiteForm({ onConfirm, onCancel }: CreateSiteFormProps) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => { inputRef.current?.focus(); }, []);

    const submit = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        onConfirm(trimmed);
    };

    return (
        <div className="px-3 py-2 bg-[var(--bg-tertiary)]">
            <label className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
                {t('cms_site.site.siteswitcher.site_name', 'Site name')}
            </label>
            <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('cms_site.site.siteswitcher.name_placeholder', 'e.g. Acme Bakery')}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') onCancel();
                }}
                className="w-full px-2 py-1.5 rounded text-xs border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
            <div className="flex justify-end gap-1 mt-2">
                <button
                    type="button"
                    onClick={onCancel}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2 py-1"
                >
                    {t('cms_site.site.siteswitcher.cancel', 'Cancel')}
                </button>
                <button
                    type="button"
                    onClick={submit}
                    disabled={!name.trim()}
                    className="text-xs px-2 py-1 rounded bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary)]/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {t('cms_site.site.siteswitcher.create', 'Create')}
                </button>
            </div>
        </div>
    );
}

import { FolderOpen, MoreVertical, Pencil, Trash2, type LucideIcon } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { StudioApp } from './types';
import useTranslation from '../../../../../hooks/useTranslation';
import IconButton from '../../../../shared/IconButton';

// ── Owner kebab menu ────────────────────────────────────────────────

interface OwnerMenuProps {
    app: StudioApp;
    onOpen: () => void;
    onRename: () => void;
    onDelete: () => void;
}

function OwnerMenu({ app, onOpen, onRename, onDelete }: OwnerMenuProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return undefined;
        const onDocMouseDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocMouseDown);
        return () => document.removeEventListener('mousedown', onDocMouseDown);
    }, [open]);

    const item = (label: string, Icon: LucideIcon, onClick: () => void, danger = false) => (
        <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setOpen(false); onClick(); }}
            className={
                'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ' +
                (danger ? 'text-rose-500 hover:bg-rose-500/10' : 'hover:bg-[var(--bg-tertiary)]')
            }
            style={danger ? undefined : { color: 'var(--text-primary)' }}
        >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            {label}
        </button>
    );

    return (
        <div
            ref={rootRef}
            className="absolute top-2 right-2"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
        >
            <IconButton
                ariaLabel={t('studio_apps_bi.list.actions_for', 'Actions for {name}', { name: app.name })}
                title={t('studio_apps_bi.list.app_actions', 'App actions')}
                size="sm"
                onClick={() => setOpen((v) => !v)}
                className={open ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity'}
            >
                <MoreVertical />
            </IconButton>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 mt-1 w-36 py-1 rounded-lg border shadow-lg z-20 [border-color:var(--border-subtle)] [background:var(--bg-secondary)]"
                >
                    {item(t('studio_apps_bi.list.open', 'Open'), FolderOpen, onOpen)}
                    {item(t('studio_apps_bi.list.rename', 'Rename'), Pencil, onRename)}
                    {item(t('studio_apps_bi.list.delete', 'Delete'), Trash2, onDelete, true)}
                </div>
            )}
        </div>
    );
}

export default OwnerMenu;

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Code, Palette, Cpu, FileText, Image as ImageIcon, FileType, Braces, X } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';

interface TabMeta {
    label: string | undefined;
    Icon: LucideIcon;
    title?: string;
}

const PRIMARY_META: Record<string, TabMeta> = {
    html: { label: 'index.html', Icon: Code },
    css:  { label: 'style.css',  Icon: Palette },
    js:   { label: 'script.js',  Icon: Cpu },
};

function iconForPath(path: string): LucideIcon {
    const ext = (path.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return ImageIcon;
    if (['html', 'htm'].includes(ext)) return Code;
    if (['css'].includes(ext)) return Palette;
    if (ext === 'json') return Braces;
    if (['js', 'mjs'].includes(ext)) return Cpu;
    if (['ttf', 'woff', 'woff2', 'otf'].includes(ext)) return FileType;
    return FileText;
}

function metaForKey(key: string): TabMeta {
    if (PRIMARY_META[key]) return PRIMARY_META[key];
    if (typeof key === 'string' && key.startsWith('extra:')) {
        const path = key.slice(6);
        return { label: path.split('/').pop(), Icon: iconForPath(path), title: path };
    }
    return { label: String(key), Icon: FileText };
}

/**
 * Editor tabs for the webpage IDE. Tabs are driven by an `openFiles` array
 * (keys: 'html' | 'css' | 'js' | 'extra:<path>'). Clicking a tab activates
 * it; the X closes it. Closing the last tab is the caller's responsibility.
 */
export default function EditorTabs({ openFiles, activeKey, onSelect, onClose, dirtyFiles = {} }: {
    openFiles: string[];
    activeKey: string | null;
    onSelect: (key: string) => void;
    onClose?: (key: string) => void;
    dirtyFiles?: Record<string, boolean>;
}) {
    const { t } = useTranslation();
    if (!Array.isArray(openFiles) || openFiles.length === 0) return null;
    return (
        <div
            className="flex items-end shrink-0 overflow-x-auto h-[35px] [background:var(--vsc-tab-inactive-bg)] [border-bottom:1px_solid_var(--vsc-border)]"
        >
            {openFiles.map((key) => {
                const { label, Icon, title } = metaForKey(key);
                const isActive = key === activeKey;
                const isDirty = !!dirtyFiles[key];
                return (
                    <div
                        key={key}
                        className="flex items-center h-full shrink-0 transition-colors border-r relative group"
                        title={title || label}
                        style={{
                            background: isActive ? 'var(--vsc-tab-active-bg)' : 'var(--vsc-tab-inactive-bg)',
                            color: isActive ? 'var(--vsc-tab-active-fg)' : 'var(--vsc-tab-inactive-fg)',
                            borderColor: 'var(--vsc-border)',
                            borderTop: isActive ? '1px solid var(--vsc-accent)' : '1px solid transparent',
                        }}
                    >
                        <button
                            onClick={() => onSelect(key)}
                            onAuxClick={(e) => { if (e.button === 1) onClose?.(key); }}
                            className="flex items-center gap-1.5 pl-3 pr-2 h-full text-[12px] [color:inherit]!"
                        >
                            <Icon size={13} />
                            <span>{label}</span>
                            {isDirty && (
                                <span
                                    className="w-2 h-2 rounded-full bg-[var(--vsc-fg-muted)]"
                                    title={t('webpages.tabs_unsaved', 'Unsaved')}
                                />
                            )}
                        </button>
                        <button
                            onClick={() => onClose?.(key)}
                            className="flex items-center justify-center h-full pr-2 opacity-40 group-hover:opacity-80 hover:opacity-100"
                            title={t('webpages.tabs_close', 'Close tab')}
                        >
                            <X size={12} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

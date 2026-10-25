import { ChevronDown, Code, Palette, Cpu, FileText, Folder, FolderOpen, Image as ImageIcon, FileType, Braces, FilePlus, Upload, Pencil, Trash2, Copy } from 'lucide-react';
import React from 'react';
import useTranslation from '../../hooks/useTranslation';
import type { ActionIconProps, FolderNodeProps, FileNodeProps } from './FileExplorer.types';

function pickIconForPath(path: string) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return ImageIcon;
    if (['html', 'htm'].includes(ext)) return Code;
    if (['css', 'scss', 'less'].includes(ext)) return Palette;
    if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(ext)) return Cpu;
    if (['json'].includes(ext)) return Braces;
    if (['ttf', 'woff', 'woff2', 'otf'].includes(ext)) return FileType;
    return FileText;
}

function ActionIcon({ Icon, title, onClick }: ActionIconProps) {
    return (
        <button
            type="button"
            title={title}
            onClick={(e) => { e.stopPropagation(); onClick(e); }}
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity [color:var(--vsc-fg-muted)]"
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--vsc-fg)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--vsc-fg-muted)')}
        >
            <Icon size={12} />
        </button>
    );
}

export function FolderNode({ node, depth, expanded, toggle, activePath, onFileSelect, actions, creating, renderCreate }: FolderNodeProps) {
    const { t } = useTranslation();
    const isOpen = expanded.has(node.path);
    const Icon = isOpen ? FolderOpen : Folder;
    return (
        <>
            <div
                role="button"
                onClick={() => toggle(node.path)}
                className="group flex items-center gap-1 py-0.5 w-full text-left text-[12px] hover:bg-[var(--vsc-hover-bg)] transition-colors cursor-pointer"
                style={{ paddingLeft: 4 + depth * 10, color: 'var(--vsc-fg)' }}
            >
                <ChevronDown size={12} style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }} />
                <Icon size={12} className="[color:var(--vsc-fg-muted)]" />
                <span className="flex-1 truncate">{node.name}</span>
                {actions && (
                    <span className="flex items-center pr-1">
                        <ActionIcon Icon={FilePlus} title={t('webpages.explorer.new_file_here', 'New file here')} onClick={() => actions.onNewFile(node.path)} />
                        <ActionIcon Icon={Upload} title={t('webpages.explorer.upload_here', 'Upload here')} onClick={() => actions.onUpload(node.path)} />
                    </span>
                )}
            </div>
            {isOpen && creating && creating.parent === node.path && renderCreate(depth + 1)}
            {isOpen && node.children.map(child => (
                child.type === 'folder' ? (
                    <FolderNode key={child.path} node={child} depth={depth + 1} expanded={expanded} toggle={toggle}
                        activePath={activePath} onFileSelect={onFileSelect} actions={actions} creating={creating} renderCreate={renderCreate} />
                ) : (
                    <FileNode key={child.path} node={child} depth={depth + 1} activePath={activePath} onFileSelect={onFileSelect} actions={actions} />
                )
            ))}
        </>
    );
}

export function FileNode({ node, depth, activePath, onFileSelect, actions }: FileNodeProps) {
    const { t } = useTranslation();
    const Icon = pickIconForPath(node.path);
    const isActive = activePath === `extra:${node.path}`;
    return (
        <div
            role="button"
            onClick={() => onFileSelect({ ...node.meta, path: node.path })}
            className="group flex items-center gap-1.5 py-0.5 w-full text-left text-[12px] transition-colors cursor-pointer"
            style={{
                paddingLeft: 4 + depth * 10,
                background: isActive ? 'var(--vsc-file-active-bg)' : 'transparent',
                color: isActive ? 'var(--vsc-fg)' : 'var(--vsc-fg-muted)',
            }}
        >
            <span className="w-[12px]" />
            {React.createElement(Icon, { size: 12 })}
            <span className="flex-1 truncate">{node.name}</span>
            {actions && (
                <span className="flex items-center pr-1">
                    <ActionIcon Icon={Copy} title={t('webpages.explorer.copy_path', 'Copy path')} onClick={() => actions.onCopyPath(node.path)} />
                    <ActionIcon Icon={Pencil} title={t('webpages.card.rename', 'Rename')} onClick={() => actions.onRename(node.path)} />
                    <ActionIcon Icon={Trash2} title={t('webpages.card.delete', 'Delete')} onClick={() => actions.onDelete(node.path)} />
                </span>
            )}
        </div>
    );
}

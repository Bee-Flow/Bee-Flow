import type { LucideIcon } from 'lucide-react';
import type React from 'react';
import type { TreeFolder, TreeFile, TreeEntry } from './fileExplorerTree';

export type FileSelect = (file: string | { path: string }) => void;

export type Creating = { kind: string; parent: string };

export interface TreeActions {
    onNewFile: (parent: string | undefined) => void;
    onUpload: (folder: string | undefined) => void;
    onRename: (path: string) => void;
    onDelete: (path: string) => Promise<void>;
    onCopyPath: (path: string) => Promise<void>;
}

/** Inline text input used for new-file / new-folder / rename. */
export interface InlineInputProps {
    depth: number;
    initial?: string;
    placeholder?: string;
    onCommit: (v: string) => void;
    onCancel: () => void;
}

export interface ActionIconProps {
    Icon: LucideIcon;
    title: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
}

export interface FolderNodeProps {
    node: TreeFolder;
    depth: number;
    activePath: string | null;
    creating: { kind: string; parent: string } | null;
    expanded: Set<string>;
    toggle: (path: string) => void;
    onFileSelect: FileSelect;
    actions: TreeActions | null;
    renderCreate: (depth: number) => React.ReactNode;
}

export interface FileNodeProps {
    node: TreeFile;
    depth: number;
    activePath: string | null;
    onFileSelect: FileSelect;
    actions: TreeActions | null;
}

/**
 * @typedef {object} FileExplorerProps
 * @property {string | { path: string } | null} [activeFile]
 * @property {(file: string | { path: string }) => void} [onFileSelect]
 * @property {Record<string, boolean>} [dirtyFiles]
 * @property {Array<import('./webpageEditorTypes').ExtraFileMeta>} [extraFiles]
 * @property {string} [framework]
 * @property {(path: string) => unknown} [onCreateFile]
 * @property {(oldPath: string, newPath: string) => unknown} [onRename]
 * @property {(path: string) => unknown} [onDelete]
 * @property {(file: File, folder?: string) => unknown} [onUploadAsset]
 * @property {boolean} [readOnly]
 *
 * @param {FileExplorerProps} props
 */
export interface FileExplorerProps {
    activeFile: string | { path: string; } | null;
    onFileSelect: FileSelect;
    dirtyFiles?: Record<string, boolean>;
    onCreateFile?: (path: string) => unknown;
    onRename?: (oldPath: string, newPath: string) => unknown;
    onDelete?: (path: string) => unknown;
    onUploadAsset?: (file: File, folder?: string) => unknown;
    extraFiles?: TreeEntry[];
    framework?: string | undefined;
    readOnly?: boolean;
}

/** Header toolbar icon button (always visible, unlike the hover ActionIcon). */
export interface ActionIconStaticProps {
    Icon: LucideIcon;
    title: string;
    onClick: () => void;
}

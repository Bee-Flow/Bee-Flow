import type { CustomIcon, IconMap } from '../../../../hooks/useIconPack';

/** One catalogue entry: the key, its label and the emoji shown until a pack overrides it. */
export interface IconEntry {
    id: string;
    label?: string;
    defaultEmoji?: string;
}

export interface IconCategory {
    name: string;
    entries?: IconEntry[];
}

/** An icon pack as /api/icons lists it. */
export interface IconPack {
    id: string;
    name: string;
    icons?: IconMap;
}

export interface BulkOptions {
    style: string;
    model: string;
    overwrite: boolean;
}

export interface BulkResult {
    ok: boolean;
    message: string | undefined;
}

export type NanoSettings = { image?: { model?: string } } | null | undefined;

export interface PackListItemProps {
    label: string;
    sub: string;
    isActive: boolean;
    isSelected: boolean;
    onSelect: () => void;
    onActivate?: () => void;
    onExport?: () => void;
    onDelete?: () => void;
}

export interface AddPackModalProps {
    onAdd: (name: string) => void;
    onClose: () => void;
}

export interface PackEditorProps {
    packId: string;
    categories: IconCategory[];
    isActive: boolean;
    onActivate: () => void;
    onExport: () => void;
    onPackChanged: (partial: Partial<IconPack>) => void;
}

export interface IconCellProps {
    entry: IconEntry;
    custom?: CustomIcon;
    onClick: () => void;
}

export interface BulkGenerateModalProps {
    pack: IconPack;
    nanoSettings: NanoSettings;
    running: boolean;
    onRun: (opts: BulkOptions) => Promise<void>;
    onClose: () => void;
}

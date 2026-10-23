import type { KindSource } from './kindColors';
import type React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { StudioSectionHeaderTab } from '../projects/workspace/studioParts';

/** The 28px kind tile: colour and shape from kindColors, glyph 15px. */
export interface KindTileProps {
    kind: string | KindSource | null;
    icon?: React.ReactNode | LucideIcon;
}

/** The name: a plain 14/600 span, or a rename-on-click button + input. */
export interface TitleProps {
    title: string;
    onRename?: (next: string) => void;
    renameRequest?: number;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

/** "Saved · v3": 11px, tertiary ink, hairline border, full radius. */
export interface StatusChipProps {
    chip?: string | React.ReactNode | null;
}

/**
 * The narrow-width fallback: the same tabs as one menu — the pattern of
 * BuilderHeader's ViewMenu, portalled through AnchoredMenu so the panel
 * cannot be clipped by the scrolling chrome a 48px bar sits in (BFSF-328).
 */
export interface TabMenuProps {
    tabs: StudioSectionHeaderTab[];
    activeTab: string | null | undefined;
    onTab?: (id: string) => void;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

/** The back arrow: 32×32, radius 8, secondary ink; its name says where it goes. */
export interface BackButtonProps {
    onBack: React.MouseEventHandler<HTMLButtonElement>;
    label: string;
}

/**
 * The centred tab strip between two flex:1 spacers (artboard 1b lines
 * 103-105), with its narrow-width menu twin. The strip and the menu are BOTH
 * in the DOM; the container query decides which one paints.
 */
export interface TabsSlotProps {
    tabs: StudioSectionHeaderTab[];
    activeTab: string | null | undefined;
    onTab?: (id: string) => void;
    fold?: string;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

/** capsule · primary · extras, in that order, never shrinking. */
export interface ActionClusterProps {
    capsule?: React.ReactNode | null;
    primary?: React.ReactNode | null;
    extras?: React.ReactNode | null;
}

export interface StudioSectionHeaderProps {
    kind: string | KindSource | null;
    icon?: React.ReactNode | LucideIcon;
    title: string;
    onRename?: (next: string) => void;
    activeTab?: string | null;
    onTab?: (id: string) => void;
    renameRequest?: number;
    statusChip?: string | React.ReactNode | null;
    tabs?: boolean | StudioSectionHeaderTab[] | null;
    tabsFold?: string;
    titleMin?: boolean;
    capsule?: React.ReactNode | null;
    primary?: React.ReactNode | null;
    extras?: React.ReactNode | null;
    onBack?: React.MouseEventHandler<HTMLButtonElement>;
    backLabel?: string;
    className?: string;
    testId?: string;
}

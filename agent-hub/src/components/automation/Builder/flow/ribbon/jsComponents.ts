import type { ComponentType, ReactNode, DragEvent } from 'react';
import CmdButtonJs from '../../../../shared/ribbon/CmdButton';
import RibbonDropdownJs from '../../../../shared/ribbon/RibbonDropdown';
import InlineButtonJs from '../../../../shared/ribbon/InlineButton';
import IntegrationLogoJs from '../nodes/IntegrationLogo';
import { AppGlyph as AppGlyphJs } from '../appGlyphs';
import type { IconType } from './ribbonCategories';

/**
 * The ribbon's JavaScript building blocks, with the prop types the ribbon
 * uses. Their `= null` defaults would otherwise type every optional prop as
 * `null` for a TypeScript caller.
 */

interface DragProps {
    draggable?: boolean;
    onDragStart?: (event: DragEvent) => void;
}

export const CmdButton = CmdButtonJs as unknown as ComponentType<DragProps & {
    icon?: IconType | null;
    glyph?: ReactNode;
    label: string;
    tipTitle?: string | null;
    desc?: string | null;
    tipFooter?: string | null;
    onClick?: () => void;
    big?: boolean;
    accent?: boolean;
    disabled?: boolean;
    grabbable?: boolean;
    'data-ribbon-origin'?: string;
}>;

export const RibbonDropdown = RibbonDropdownJs as unknown as ComponentType<{
    label: string;
    tipTitle?: string | null;
    desc?: string | null;
    tipFooter?: string | null;
    icon?: IconType | null;
    glyph?: ReactNode;
    open: boolean;
    onToggle: () => void;
    children?: ReactNode;
    align?: 'left' | 'right';
    width?: number;
    buttonProps?: Record<string, unknown> | null;
}>;

export const InlineButton = InlineButtonJs as unknown as ComponentType<DragProps & {
    icon?: IconType | null;
    label: string;
    onClick?: () => void;
}>;

export const IntegrationLogo = IntegrationLogoJs as unknown as ComponentType<{
    integrationId?: string | null;
    tool?: string | null;
    size?: number;
}>;

export const AppGlyph = AppGlyphJs as unknown as ComponentType<{ integrationId: string; size?: number }>;

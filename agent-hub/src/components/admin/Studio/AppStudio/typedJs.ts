/**
 * Typed views of the JavaScript components the App Studio's TypeScript files
 * render. A .jsx module's `= null` / `= []` defaults make TypeScript read
 * those props as null-only (or never[]), so a caller passing a real value
 * does not typecheck. Each view names the props its callers use, matching
 * the component's own destructuring; the component itself is untouched.
 *
 * Only modules from below the App Studio live here (shared/, icons/): a view
 * of an App Studio component belongs next to its one caller, or this file
 * would pull every caller into that component's import cycle.
 */
import type { ComponentType, CSSProperties, ReactNode, RefObject } from 'react';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import AppIconJs from '../../../icons/AppIcon';

export interface AnchoredMenuProps {
    open?: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    align?: 'stretch' | 'left' | 'right';
    width?: number | null;
    minWidth?: number;
    maxHeight?: number | null;
    closeOnEscape?: boolean;
    className?: string;
    style?: CSSProperties | null;
    role?: string;
    children?: ReactNode;
    [attr: `aria-${string}` | `data-${string}`]: unknown;
}

export const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<AnchoredMenuProps>;

export interface AppIconProps {
    name?: string | null;
    className?: string;
    style?: CSSProperties;
}

export const AppIcon = AppIconJs as unknown as ComponentType<AppIconProps>;

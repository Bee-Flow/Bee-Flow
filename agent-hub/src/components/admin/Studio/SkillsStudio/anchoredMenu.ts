import type { ComponentType, CSSProperties, ReactNode, RefObject } from 'react';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';

/**
 * The props `shared/AnchoredMenu.jsx` honours. The JS component defaults
 * `width` and `maxHeight` to `null`, which TypeScript reads as the only legal
 * value at a call site, so a numeric width would not type-check there.
 */
export interface AnchoredMenuProps {
    open?: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    align?: 'left' | 'right' | 'stretch';
    width?: number;
    minWidth?: number;
    maxHeight?: number;
    closeOnEscape?: boolean;
    className?: string;
    style?: CSSProperties;
    role?: string;
    'aria-label'?: string;
    children?: ReactNode;
}

export const AnchoredMenuTyped = AnchoredMenuJs as ComponentType<AnchoredMenuProps>;

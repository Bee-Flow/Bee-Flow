import type { CSSProperties } from 'react';
import type { NodeStyle } from '../inspector/appDefinition';

/** The inline style object a resolved node or section carries. */
export type InlineStyle = CSSProperties;

/** The knobs this module translates: authored data, so every one may be absent or unvalidated. */
export type StyleKnobs = NodeStyle & {
    weight?: string;
    color?: string | null;
    radius?: string | null;
    background?: string;
    border?: string;
    hideBelow?: string;
    hideAbove?: string;
    widthMode?: string;
    widthValue?: number | null;
    heightMode?: string;
    heightValue?: number | null;
};

/** The part of a node (or a section) these helpers read. */
export interface StyledNode {
    style?: StyleKnobs | null;
    children?: StyledNode[] | null;
}

/** What a node's grid cell gets. */
export interface ResolvedNodeStyle {
    className: string;
    style: InlineStyle;
}

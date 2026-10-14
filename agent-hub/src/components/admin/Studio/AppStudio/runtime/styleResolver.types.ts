/** The style knobs of one node or section, as canonicalize.js stores them. */
export interface StyleKnobs {
    span?: number;
    align?: string;
    weight?: string;
    size?: string;
    height?: string;
    color?: string | null;
    radius?: string | null;
    padding?: number;
    gap?: number;
    background?: string | null;
    border?: string | null;
    hideBelow?: string | null;
    hideAbove?: string | null;
    widthMode?: string | null;
    widthValue?: number | null;
    heightMode?: string | null;
    heightValue?: number | null;
    [key: string]: unknown;
}

/** The subset of a node / section that the style resolvers read. */
export interface StyledNode {
    style?: Record<string, unknown> | null;
    children?: StyledNode[] | null;
}

/** One resolved style: a className for the wrapper and the inline style. */
export interface ResolvedStyle {
    className: string;
    style: Record<string, string | number>;
}


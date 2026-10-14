/**
 * The shape of one node as the App Studio runtime renders it. Shared by the
 * runtime component modules so each one names only the props it reads.
 * Index signatures carry fields no component here reads through untouched.
 */

/** Layout and look hints the renderer resolves per node. */
export interface RuntimeNodeStyle {
    gap?: number;
    padding?: number;
    size?: string;
    span?: unknown;
    height?: unknown;
    [key: string]: unknown;
}

export interface RuntimeNode<P = Record<string, unknown>> {
    id: string;
    type?: string;
    props: P;
    style: RuntimeNodeStyle;
    children?: RuntimeNode[];
    [key: string]: unknown;
}

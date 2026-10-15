import type { ReactNode } from 'react';

/** Shared types of the App Studio runtime components. */

/** The style knobs a node carries (spec: server/appStudio/componentSpecs.js). */
export interface NodeStyle {
    span?: number;
    gap?: number;
    padding?: number;
    height?: number | string;
    size?: string;
}

/** A canonical app node as the runtime renders it; `P` is the shape of its props. */
export interface AppNode<P = Record<string, unknown>> {
    id: string;
    type?: string;
    props: P;
    style: NodeStyle;
    children?: AppNode[];
}

/** The props every runtime component receives. */
export interface NodeProps<P = Record<string, unknown>> {
    node: AppNode<P>;
    children?: ReactNode;
}

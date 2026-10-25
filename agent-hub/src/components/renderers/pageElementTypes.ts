import type { CSSProperties, ReactNode } from 'react';

/** A tab of a `tabs` element. */
interface PageTab {
    label?: ReactNode;
    children?: unknown[];
}

/** An entry of an `accordion` element. */
export interface PageAccordionItem {
    title?: ReactNode;
    content?: ReactNode;
    children?: unknown[];
}

/** A column header of a `table` element. */
export type PageTableColumn = string | { label?: ReactNode };

/** A row of a `table` element. */
type PageTableRow = ReactNode[] | Record<string, ReactNode>;

/** One bar of a `chart` element. */
export interface ChartDatum {
    label?: ReactNode;
    value: number;
    color?: string;
}

/**
 * One element of a page definition (parsed from JSON). Every field is
 * optional: the model-written definition is only trusted for its shape,
 * `isPageElement` checks the outermost one at runtime.
 */
export interface PageElement {
    type?: string;
    id?: string;
    title?: string;
    text?: string;
    label?: string;
    alt?: string;
    src?: string;
    url?: string;
    href?: string;
    action?: string;
    variant?: string;
    color?: string;
    fit?: CSSProperties['objectFit'];
    align?: CSSProperties['alignItems'];
    justify?: CSSProperties['justifyContent'];
    level?: number;
    gap?: number | string;
    height?: number | string;
    ordered?: boolean;
    content?: ReactNode;
    overlay?: ReactNode;
    description?: ReactNode;
    value?: ReactNode;
    change?: number;
    columns?: number | PageTableColumn[];
    rows?: PageTableRow[];
    tabs?: PageTab[];
    items?: unknown[];
    children?: unknown[] | string | number;
    data?: unknown;
}

export function isPageElement(value: unknown): value is PageElement {
    return typeof value === 'object' && value !== null;
}

/** What the per-kind renderers need from the component that owns the page. */
export interface PageRenderContext {
    renderElement: (element: unknown, index?: number) => ReactNode;
    onButtonClick: (element: PageElement) => void;
}

export type PageElementRenderer = (element: PageElement, key: string, ctx: PageRenderContext) => ReactNode;

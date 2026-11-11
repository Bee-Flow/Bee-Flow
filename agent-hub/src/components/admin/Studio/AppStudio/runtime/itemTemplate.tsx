import { createContext, useContext, type ReactNode } from 'react';
import { rowKey, useRuntime, type ExpressionScope } from './RuntimeContext';
import { gridTemplate, keepSmClass, spaceSteps } from './styleResolver/layout';
import type { AppNode } from '../inspector/appDefinition';

/**
 * App Studio runtime: the item template of a `list` row and a `kanban` card (schema 3,
 * server/appStudio/componentSpecs/itemTemplates.js).
 *
 * The children of such a node are ordinary nodes drawn once per row, with `item`, `index` and
 * `value` in scope: the per-row scope AppRenderer gives a repeater's children. AppRenderer
 * provides the renderer (its own RenderNode, with the canvas's NodeWrapper and mode), so the
 * cells, error boundaries and editor selection are exactly those of any other node. A list or
 * kanban without children never reads this and renders as it always did.
 */

export type RenderNodes = (nodes: readonly AppNode[], scope: ExpressionScope, keyPrefix: string) => ReactNode;

/** AppRenderer's renderer for template nodes; null outside a renderer (a component rendered on its own in a test). */
export const ItemTemplateContext = createContext<RenderNodes | null>(null);

/** The types whose children are an item template. */
const HOST_TYPES: ReadonlySet<string> = new Set(['list', 'kanban']);

/** Does `node` carry an item template? */
export function hasItemTemplate(node: Pick<AppNode, 'type' | 'children'> | null | undefined): boolean {
    return !!node && HOST_TYPES.has(node.type) && Array.isArray(node.children) && node.children.length > 0;
}

/** Draws one row's template; null when the node has none (the built-in body applies). */
export type RowTemplate = (item: unknown, index: number) => ReactNode;

/** A host's row template for a body drawn further down (a kanban card and its drag copy). */
export const RowTemplateContext = createContext<RowTemplate | null>(null);

/**
 * The template of `node` as a function of one row, or null for a node without one. The nodes sit
 * on a 12-column grid like a repeater item's, so their span works as everywhere else.
 */
export function useItemTemplate(node: Pick<AppNode, 'id' | 'type' | 'children'>, part: string): RowTemplate | null {
    const render = useContext(ItemTemplateContext);
    const { scope } = useRuntime();
    if (!render || !hasItemTemplate(node)) return null;
    const nodes = node.children as AppNode[];
    const keep = keepSmClass(nodes as never);
    return (item, index) => (
        <div
            className={`app-grid${keep} bfa-${node.type}__${part}`}
            style={{ gridTemplateColumns: gridTemplate(), gap: spaceSteps(2) }}
            data-app-item-template={node.id}
        >
            {render(nodes, { ...scope, item, index, value: item }, rowKey(item, index))}
        </div>
    );
}

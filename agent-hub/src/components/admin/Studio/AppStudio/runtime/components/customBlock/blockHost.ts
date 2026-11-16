import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { isBlockName } from '@shared/blockTemplate/index.mjs';
import { resolveBinding } from '../../resolveBinding';
import type { RuntimeValue } from '../../RuntimeContext';
import { HEIGHT_PX } from '../../styleResolver.constants';
import { isFill, resolveHeightCss } from '../../styleResolver.helpers';
import type { NodeProps } from '../appNode.types';
import { FALLBACK_THEME, resolveBlockTheme, type BlockTheme } from './blockTheme';

/**
 * App Studio runtime: what the host page does for a block drawn in a frame, the same for a
 * `custom_block` (./AppCustomBlock.tsx) and a `react_block` (../reactBlock/AppReactBlock.tsx):
 * resolve its inputs under the viewer's own session, read the app's look where it sits, name
 * the events that run an action, and decide whether it fills a fixed box.
 */

/** The entries of a `{ name: value }` map of a block, or none when it is not one. */
export function blockEntries(map: unknown): Array<[string, unknown]> {
    return map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map as Record<string, unknown>) : [];
}

/** `value` as plain JSON data: what a formula of the block may see, and what an action is handed. */
export function jsonSafe(value: unknown): unknown {
    if (value === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
        return null;
    }
}

/** The block's inputs resolved for this viewer, as plain data, and one text that changes when they do. */
export function useBlockScope(block: { inputs?: unknown }, runtime: RuntimeValue) {
    const { actionState, dataState, scope } = runtime;
    const values: Record<string, unknown> = {};
    for (const [name, binding] of blockEntries(block.inputs)) {
        // A stored block has usable names only; one that never passed the server may not.
        if (!isBlockName(name)) continue;
        values[name] = jsonSafe(resolveBinding(binding as never, { actionState, dataState, scope } as never).value);
    }
    const payload = JSON.stringify(values);
    return useMemo(() => ({ values: JSON.parse(payload) as Record<string, unknown>, payload }), [payload]);
}

/** The events of the block that name an action: event name → action id. */
export function wiredEvents(events: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, actionId] of blockEntries(events)) if (isBlockName(name) && typeof actionId === 'string' && actionId) out[name] = actionId;
    return out;
}

/**
 * The app's look where the block sits. The theme reaches the page as attributes and inline
 * variables on the elements around the block (the app shell, the host theme on <html>), so
 * it is read once the block is drawn (`drawn`) and again whenever one of those changes.
 */
export function useBlockTheme(hostRef: RefObject<HTMLDivElement | null>, drawn: boolean): BlockTheme {
    const [theme, setTheme] = useState<BlockTheme>(FALLBACK_THEME);
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        const read = () => {
            const next = resolveBlockTheme(host);
            setTheme((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
        };
        read();
        if (typeof MutationObserver === 'undefined') return undefined;
        const observer = new MutationObserver(read);
        for (let el = host.parentElement; el; el = el.parentElement) observer.observe(el, { attributes: true });
        return () => observer.disconnect();
    }, [hostRef, drawn]);
    return theme;
}

/** A height from the style knobs wins; without one the frame is as tall as its content. */
export function isBoxed(node: NodeProps<unknown>['node']): boolean {
    const style = node.style as { height?: string } | undefined;
    return isFill(node as never) || Boolean(resolveHeightCss(style as never)) || Boolean(HEIGHT_PX[style?.height || '']);
}

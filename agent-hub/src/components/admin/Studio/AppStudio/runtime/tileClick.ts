import type { KeyboardEvent, MouseEvent } from 'react';
import { typeEvents } from './catalogSnapshot.generated.json';
import type { AppNode } from '../inspector/appDefinition';

/**
 * `onClick` on a component that is not a button (schema 3: card, image, stat, callout,
 * container). The whole grid cell becomes the control: role="button", focusable, Enter
 * or Space runs it like a click.
 *
 * Only in run mode, only when the node is wired and enabled, and never for a click that
 * lands on something interactive inside it (a button in a card runs its own action, not
 * the card's as well). A node without onClick gets nothing, so its markup is what it was.
 *
 * The cell is the target rather than each component's root, so the five component files
 * stay as they are; the editor's own node wrapper ignores these props, so the canvas
 * never runs anything.
 */

/** The props DefaultNodeWrapper spreads onto the cell. */
export interface TileClickProps {
    role: 'button';
    tabIndex: 0;
    'data-app-click': 'true';
    onClick: (e: MouseEvent<HTMLElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

const EVENTS = typeEvents as Record<string, string[] | undefined>;

/** Elements inside a clickable tile that keep their own click. */
const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], [contenteditable="true"]';

/** True when the event started on an interactive element nested inside the tile. */
function fromInnerControl(e: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== 'function') return false;
    const hit = target.closest(INTERACTIVE);
    return !!hit && hit !== e.currentTarget;
}

/** True for a type that fires onClick without being a button. */
function isTileClickType(type: unknown): boolean {
    return typeof type === 'string' && type !== 'button' && !!EVENTS[type]?.includes('onClick');
}

/**
 * The cell's click props, or null when the node is not a clickable tile right now.
 * `runAction` takes the slot as stored (one id or a list).
 */
export function tileClickProps(
    node: AppNode,
    mode: string,
    runAction: (slot: string, opts?: Record<string, unknown>) => unknown,
    disabled: boolean,
): TileClickProps | null {
    const slot = node.onClick as unknown;
    const wired = typeof slot === 'string' ? slot !== '' : Array.isArray(slot) && slot.length > 0;
    if (mode !== 'run' || disabled || !wired || !isTileClickType(node.type)) return null;
    const run = () => { void runAction(slot as string, {}); };
    return {
        role: 'button',
        tabIndex: 0,
        'data-app-click': 'true',
        onClick: (e) => {
            if (e.defaultPrevented || fromInnerControl(e)) return;
            run();
        },
        onKeyDown: (e) => {
            if ((e.key !== 'Enter' && e.key !== ' ') || e.target !== e.currentTarget) return;
            e.preventDefault();
            run();
        },
    };
}

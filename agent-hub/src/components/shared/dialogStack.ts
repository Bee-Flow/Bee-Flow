import { createContext, useSyncExternalStore } from 'react';

/**
 * The open <Modal/>s, in the order they opened — the last one is on top.
 *
 * Before this, every Modal stacked by its own z-index, so a confirmation at
 * the z-50 default opened BEHIND the dialog that asked for it whenever that
 * dialog sat higher (the notebook version history at z-9999, the automation
 * flyout at z-1500): a dimmed screen with the button out of reach. Now a
 * dialog keeps the level it asked for unless that would put it at or below
 * the dialog under it, and then it goes one above. A lone dialog renders
 * exactly as it always did; a confirmation never needs to know the number
 * of the dialog it interrupts.
 *
 * The stack also owns what belongs to all open dialogs together: the one
 * Escape listener (the top dialog answers it) and the lock on the page's
 * scroll (held while any dialog is open).
 */

/** The level of the `z-50` class every Modal overlay carries. */
export const DEFAULT_Z_INDEX = 50;

export interface DialogEntry {
    /** The dialog this one is rendered inside (React tree, not DOM), if any. */
    readonly parent: DialogEntry | null;
    /** The level the caller asked for; the stack may raise it, never lower it. */
    floor: number;
    /** What Escape does while this dialog is on top; null while it may not close. */
    onEscape: (() => void) | null;
}

/** The entry of the Modal a component is rendered inside. */
export const ParentDialog = createContext<DialogEntry | null>(null);

const stack: DialogEntry[] = [];
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
    version += 1;
    listeners.forEach((listener) => listener());
}

function isInside(entry: DialogEntry, outer: DialogEntry): boolean {
    for (let p = entry.parent; p; p = p.parent) if (p === outer) return true;
    return false;
}

/**
 * Escape belongs to the top dialog. One listener for the whole stack, not one
 * per dialog: with one each, a single Escape closed every open dialog, and a
 * dialog that asked "are you sure?" on close asked it again as the answer
 * was being cancelled.
 */
function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    // As before, the key stops at the document while any open dialog listens
    // for it, so a window-level Escape handler behind the dialogs (SideDrawer's)
    // does not act on it as well, even while the top one holds it back.
    if (!stack.some((each) => each.onEscape)) return;
    e.stopPropagation();
    stack[stack.length - 1].onEscape?.();
}

/**
 * No scrolling the page behind the dialogs: the body is locked when the
 * first dialog opens and gets its own values back when the last one closes.
 * The padding stands in for a scrollbar that disappears with the lock, so
 * the page does not shift sideways under the backdrop.
 */
function lockScroll(): () => void {
    const { body, documentElement } = document;
    const before = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    const scrollbar = documentElement.clientWidth > 0 ? window.innerWidth - documentElement.clientWidth : 0;
    if (scrollbar > 0) {
        const padding = parseFloat(getComputedStyle(body).paddingRight) || 0;
        body.style.paddingRight = `${padding + scrollbar}px`;
    }
    body.style.overflow = 'hidden';
    return () => {
        body.style.overflow = before.overflow;
        body.style.paddingRight = before.paddingRight;
    };
}

let releaseScroll: (() => void) | null = null;

export function openDialog(entry: DialogEntry): void {
    if (stack.includes(entry)) return;
    // On top, except under a dialog nested inside this one that registered
    // first: React runs a child's layout effects before its parent's, so a
    // parent and child that open in the same render arrive child-first.
    const nested = stack.findIndex((other) => isInside(other, entry));
    stack.splice(nested === -1 ? stack.length : nested, 0, entry);
    if (stack.length === 1) {
        document.addEventListener('keydown', onKeyDown);
        releaseScroll = lockScroll();
    }
    changed();
}

export function closeDialog(entry: DialogEntry): void {
    const at = stack.indexOf(entry);
    if (at === -1) return;
    stack.splice(at, 1);
    if (stack.length === 0) {
        document.removeEventListener('keydown', onKeyDown);
        releaseScroll?.();
        releaseScroll = null;
    }
    changed();
}

export function setDialogEscape(entry: DialogEntry, onEscape: (() => void) | null): void {
    entry.onEscape = onEscape;
}

export function setDialogFloor(entry: DialogEntry, floor: number): void {
    if (entry.floor === floor) return;
    entry.floor = floor;
    if (stack.includes(entry)) changed();
}

/**
 * The z-index the dialog renders at: its own floor, or one above the dialog
 * below. A dialog that is opening renders before it registers, so one not on
 * the stack yet is placed where it is about to go: on top.
 */
export function stackLevel(entry: DialogEntry): number {
    let level = -Infinity;
    for (const each of stack) {
        level = Math.max(each.floor, level + 1);
        if (each === entry) return level;
    }
    return Math.max(entry.floor, level + 1);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function ignore(): () => void {
    return () => {};
}

function getVersion(): number {
    return version;
}

/**
 * Re-renders an OPEN dialog whenever another one opens or closes, so its
 * level follows the stack. A closed one does not listen: it renders nothing.
 */
export function useDialogStack(open: boolean): void {
    useSyncExternalStore(open ? subscribe : ignore, getVersion, getVersion);
}

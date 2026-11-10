/**
 * The gates on a node that decide whether the phone may draw it.
 *
 * The phone has no formula engine for App Studio flags, so a gate it cannot
 * evaluate is treated as closed: drawing the node anyway would show (and, for a
 * form field, submit) something the owner conditioned off.
 */

import type { AppNode } from './types';

/** Mirrors roleAllows() on the server: an absent or empty gate is open. */
export function roleAllows(node: AppNode, viewerRole: string | null | undefined): boolean {
    const gate = node.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return typeof viewerRole === 'string' && gate.includes(viewerRole);
}

/** True when the node carries a visibleWhen or enabledWhen gate (the phone evaluates neither). */
export function hasFormulaGate(node: AppNode): boolean {
    return node.visibleWhen != null || node.enabledWhen != null;
}

/**
 * Whether a form field (or a container inside a form) stays off the phone and
 * out of the submitted values, and if so whether it is named as missing.
 *
 * - `hidden`: the viewer's role may not see it. Not named, as on the screen.
 * - `unsupported`: a condition the phone cannot evaluate (visibleWhen,
 *   enabledWhen, or a `visible` that is not a plain boolean). Named.
 * - `open`: drawn and submitted.
 */
export function fieldGate(node: AppNode, viewerRole: string | null | undefined): 'open' | 'hidden' | 'unsupported' {
    if (!roleAllows(node, viewerRole)) return 'hidden';
    const visible: unknown = node.visible;
    if (hasFormulaGate(node) || (visible != null && typeof visible !== 'boolean')) return 'unsupported';
    return 'open';
}

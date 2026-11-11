/**
 * App Studio inspector: which style knob GROUPS added after the base a node or section earns.
 *
 * Mirrors componentSpecs.expandStyleKnobs on the server: a group joins every knob list that
 * holds its `grantedBy` knob ('*': every list) unless the component type is in its
 * `withheldFrom`. The groups come from the catalog snapshot, the drawing (title, labels) from
 * the group's runtime file (runtime/styleKnobs/<group>.ts).
 */

import { extensionKnobGroups } from '../runtime/catalogSnapshot.generated.json';
import { STYLE_KNOB_HANDLERS, type StyleKnobHandler } from '../runtime/styleKnobHandlers';

export interface ExtensionKnobGroup {
    name: string;
    grantedBy: string;
    knobs: readonly string[];
    withheldFrom?: readonly string[];
}

export interface EarnedKnobGroup {
    name: string;
    /** The group's knobs the list does not already name (StyleSection draws those). */
    knobs: string[];
    handler: StyleKnobHandler | null;
}

const SHIPPED = extensionKnobGroups as readonly ExtensionKnobGroup[];

/** The extension groups `knobs` (a type's base list, or the section's) earns; `type` null for a section. */
export function earnedKnobGroups(
    knobs: readonly string[],
    type: string | null,
    groups: readonly ExtensionKnobGroup[] = SHIPPED,
): EarnedKnobGroup[] {
    const out: EarnedKnobGroup[] = [];
    for (const group of groups) {
        if (group.grantedBy !== '*' && !knobs.includes(group.grantedBy)) continue;
        if (type !== null && group.withheldFrom?.includes(type)) continue;
        const earned = group.knobs.filter((k) => !knobs.includes(k));
        if (!earned.length) continue;
        const handler = STYLE_KNOB_HANDLERS.find((h) => h.group === group.name)?.handler ?? null;
        out.push({ name: group.name, knobs: earned, handler });
    }
    return out;
}

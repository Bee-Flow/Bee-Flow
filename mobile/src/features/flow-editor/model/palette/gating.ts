/**
 * What the step picker may offer where — the gating half of the web builder's
 * flow/stepPalette.js, pinned by palette.lockstep.test.ts.
 *
 *   - Filtered: inside a flowlet or a loop body, the three kinds the
 *     validator refuses there (a pause cannot resume inside a sub-graph, and
 *     "back to the app" ends a run a sub-graph is not the end of).
 *   - Disabled with a reason: a form step without a form trigger; a Code step
 *     the server says would be refused. Shown, not hidden, so the capability
 *     and the rule behind it stay discoverable (BFSF-348).
 */

import { nodeDesc, nodeLabel } from '../nodeDefs';
import type { Translate } from '../types';
import { CODE_ITEM } from './items';
import type { PaletteCatalog, PaletteItem } from './types';

/** The palette mirror of the validator's nested-scope rules. */
export const NOT_INSIDE_A_LAYER: ReadonlySet<string> = new Set(['approval', 'form_page', 'return_to_app']);

const NEEDS_FORM_TRIGGER: ReadonlySet<string> = new Set(['form_page']);
export const NEEDS_FORM_TRIGGER_REASON = 'Form steps run on the routine\'s own form link — switch the trigger to "Form" to use this.';

/**
 * Stamp `disabled` + `disabledReason` on an item whose precondition the graph
 * does not meet. `hasFormTrigger` is a TRI-STATE: only a definite `false`
 * disables. An item that is fine comes back as the SAME object.
 */
export function gated(item: PaletteItem, hasFormTrigger: boolean | null | undefined): PaletteItem {
    if (!NEEDS_FORM_TRIGGER.has(item?.payload?.kind) || hasFormTrigger !== false) return item;
    return { ...item, disabled: true, disabledReason: NEEDS_FORM_TRIGGER_REASON, disabledReasonKey: 'mobile.flow.palette.needs_form_trigger' };
}

/**
 * Why a code step would be refused, by the server's `flags.codeReason`. There
 * is no switch for code steps: they run wherever the server has its sandbox,
 * so the only reason is 'runtime'. Anything else, such as the 'platform' or
 * 'org' an older server may still send, reads as 'unknown'.
 */
export const CODE_OFF_REASONS: Readonly<Record<string, string>> = {
    runtime: 'This server was installed without the code sandbox, so a code step could not run here.',
    unknown: 'This server did not say whether it can run code steps, so a code step could still be refused when it runs.',
};

/**
 * The Code entry as the catalog allows it: addable (`flags.code === true`,
 * the literal), inert with the server's reason, or absent when the catalog
 * says nothing at all.
 */
export function codeItemFor(catalog: PaletteCatalog | null | undefined): PaletteItem | null {
    if (catalog?.flags?.code === true) return CODE_ITEM;
    const reason = catalog?.flags?.codeReason;
    if (!reason) return null;
    const known = Object.prototype.hasOwnProperty.call(CODE_OFF_REASONS, reason) ? reason : 'unknown';
    return {
        ...CODE_ITEM, disabled: true, disabledReason: CODE_OFF_REASONS[known] as string,
        disabledReasonKey: `mobile.flow.palette.code_off_${known}`,
    };
}

/** The disabled reason in the viewer's language, when it has a key. */
function withReason(it: PaletteItem, t: Translate): PaletteItem {
    if (!it.disabledReasonKey || !it.disabledReason) return it;
    return { ...it, disabledReason: t(it.disabledReasonKey, it.disabledReason) };
}

/**
 * An item's label/description in the viewer's language. An item the picker
 * words itself translates through its own keys; a step item only while it
 * still carries its type's canonical English (a user-named flowlet keeps its
 * own words), through `routines.node.*` as on the web. The same object when
 * nothing changes.
 */
export function localised(item: PaletteItem, t: Translate | null | undefined): PaletteItem {
    if (!t) return item;
    const it = withReason(item, t);
    if (it.labelKey) {
        return { ...it, label: t(it.labelKey, it.label), desc: it.descKey ? t(it.descKey, it.desc) : it.desc };
    }
    const kind = it.payload?.kind;
    const canonical = kind ? nodeLabel(kind) : '';
    if (!canonical || it.label !== canonical) return it;
    return { ...it, label: nodeLabel(kind, t), desc: nodeDesc(kind, t) || it.desc };
}

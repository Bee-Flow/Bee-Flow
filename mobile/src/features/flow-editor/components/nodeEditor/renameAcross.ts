/**
 * A declared field's binding renamed across the whole open automation as ONE
 * draft-store edit — the host half of the web's `onRenameField` (the builder
 * rewrites every ref, template and expression that points at the old name,
 * and the form's own declaration with them). Answers how many bindings moved,
 * or undefined when nothing could be renamed (edits are locked, a bad name).
 */

import type { DraftStore } from '@/features/flow-editor/state';

import { renameFormField } from '../editors/shared/renameField';

export function renameAcross(store: DraftStore, base: string, from: string, to: string): number | undefined {
    let moved: number | undefined;
    store.getState().applyOp((definition) => {
        const out = renameFormField(definition, { base, from, to });
        if (!out.ok) return definition;
        moved = out.rewritten;
        return out.definition;
    });
    return moved;
}

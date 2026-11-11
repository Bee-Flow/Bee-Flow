/**
 * App Studio editor: rearranging sections and screens.
 *
 * The five ops are the shared ones (@shared/appDefinition/structureOps.mjs, GENERATED from
 * server/shared/appDefinition/ by `npm run gen:shared`), the same code the server's builder
 * tools run. They live in this module rather than in state/definitionOps.ts on purpose: the
 * phone's ops port (mobile/.../core/ops) is held export for export to that module, and these
 * are not ported. structureOps.lockstep.test.ts holds them to the server golden.
 *
 * On top of them, the editor's own deleteSection: a section's components go out through
 * removeNode first, so a deleted modal takes its open/close references with it (a dangling
 * modal reference fails every later save), and the screen keeps at least one section.
 */

import { updateSection, moveSection, duplicateSection, moveScreen, duplicateScreen } from '@shared/appDefinition/definitionOps.mjs';
import { findSection } from '@shared/appDefinition/definitionOps.mjs';
import { limits } from '../runtime/catalogSnapshot.generated.json';
import { removeNode, removeSection } from './definitionOps';
import type { AppDefinition, AppNode } from '../inspector/appDefinition';

export { updateSection, moveSection, duplicateSection, moveScreen, duplicateScreen };

/** The definition-validity limits the server enforces (componentSpecs/limits.js). */
export const MAX_SECTIONS_PER_SCREEN: number = limits.MAX_SECTIONS_PER_SCREEN;
export const MAX_SCREENS: number = limits.MAX_SCREENS;

/** Remove a section and everything in it, the way deleting each component would. */
export function deleteSection(def: AppDefinition, sectionId: string): AppDefinition {
    const found = findSection(def, sectionId);
    if (!found) return def;
    let next = def;
    for (const child of (found.section.children || []) as AppNode[]) {
        if (child && child.id) next = removeNode(next, child.id) as AppDefinition;
    }
    return removeSection(next, sectionId);
}

/** Where a section sits: its index and how many sections its screen has, or null. */
export function sectionPlace(def: AppDefinition | null, sectionId: string | null): { index: number; count: number; screenId: string } | null {
    const found = def && sectionId ? findSection(def, sectionId) : null;
    if (!found) return null;
    return { index: found.index, count: (found.screen.sections || []).length, screenId: found.screen.id };
}

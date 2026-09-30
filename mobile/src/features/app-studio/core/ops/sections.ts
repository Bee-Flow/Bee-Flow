/**
 * Section ops. Port of the section half of the "Screen / section ops" block of
 * definitionOps.js. A screen always keeps at least one section.
 */

import type { AppDefinition, AppScreen } from '../types';
import { emptySection, insertAt } from './ids';
import { collectIds } from './tree';

/** Insert an empty section into a screen at index (clamped). Returns { def, sectionId }. */
export function addSection<D extends AppDefinition>(
    def: D,
    screenId: string,
    index?: number | null,
): { def: D; sectionId: string | null } {
    const screens = def.screens || [];
    const idx = screens.findIndex((s) => s.id === screenId);
    if (idx === -1) return { def, sectionId: null };
    const section = emptySection(collectIds(def));
    const screen = screens[idx] as AppScreen;
    const nextScreens = screens.slice();
    nextScreens[idx] = { ...screen, sections: insertAt(screen.sections || [], index, section) };
    return { def: { ...def, screens: nextScreens }, sectionId: section.id };
}

/** Remove a section; removing a screen's only section replaces it with a fresh empty one. */
export function removeSection<D extends AppDefinition>(def: D, sectionId: string): D {
    const screens = def.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const screen = screens[s] as AppScreen;
        const sections = screen.sections || [];
        if (!sections.some((sec) => sec.id === sectionId)) continue;
        const remaining = sections.filter((sec) => sec.id !== sectionId);
        const nextScreens = screens.slice();
        nextScreens[s] = { ...screen, sections: remaining.length ? remaining : [emptySection(collectIds(def))] };
        return { ...def, screens: nextScreens };
    }
    return def;
}

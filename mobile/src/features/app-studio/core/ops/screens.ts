/**
 * Screen ops. Port of the screen half of the "Screen / section ops" block of
 * definitionOps.js.
 */

import type { AppDefinition, AppScreen } from '../types';
import { removeAction, stripScreenRefs } from './actions';
import { emptySection, isNoopPatch, uniqueId } from './ids';
import { collectIds } from './tree';

/**
 * The name a screen gets when none is given. It is DATA (it lands in the
 * definition, the server's default is the same word), not interface text.
 */
export const DEFAULT_SCREEN_NAME = 'Screen';

/** Append a new screen (with one empty section). Returns { def, screenId }. */
export function addScreen<D extends AppDefinition>(def: D, { name }: { name?: unknown } = {}): { def: D; screenId: string } {
    const taken = collectIds(def);
    const screenId = uniqueId('screen', taken);
    const screen: AppScreen = {
        id: screenId,
        name: typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_SCREEN_NAME,
        icon: null,
        showInNav: true,
        maxWidth: 'medium',
        sections: [emptySection(taken)],
    };
    return { def: { ...def, screens: [...(def.screens || []), screen] }, screenId };
}

/**
 * Remove a screen. Refuses (same def) when it is the last one; repoints
 * homeScreenId when it targeted the removed screen, and strips every navigate
 * reference to it: a navigate ACTION goes (with its wiring), as do
 * onSuccess/onError navigateTo and navigate steps inside sequences.
 */
export function removeScreen<D extends AppDefinition>(def: D, screenId: string): D {
    const screens = def.screens || [];
    if (screens.length <= 1 || !screens.some((s) => s.id === screenId)) return def;
    const remaining = screens.filter((s) => s.id !== screenId);
    let next: D = { ...def, screens: remaining };
    if (def.homeScreenId === screenId) next.homeScreenId = (remaining[0] as AppScreen).id;
    for (const [actionId, action] of Object.entries(next.actions || {})) {
        if (action && action.kind === 'navigate' && action.screenId === screenId) next = removeAction(next, actionId);
    }
    const actions = stripScreenRefs(next.actions, screenId);
    return actions === next.actions ? next : { ...next, actions };
}

/** Shallow-patch screen settings. `id` and `sections` are op-managed and ignored. */
export function updateScreen<D extends AppDefinition>(def: D, screenId: string, patch: Record<string, unknown> | null | undefined): D {
    if (!patch || typeof patch !== 'object') return def;
    const screens = def.screens || [];
    const idx = screens.findIndex((s) => s.id === screenId);
    if (idx === -1) return def;
    const { id: _id, sections: _sections, ...rest } = patch;
    const screen = screens[idx] as AppScreen;
    if (isNoopPatch(screen, rest)) return def;
    const nextScreens = screens.slice();
    nextScreens[idx] = { ...screen, ...rest };
    return { ...def, screens: nextScreens };
}

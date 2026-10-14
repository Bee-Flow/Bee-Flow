/**
 * App Studio — ensureIds: repair AI-generated or imported definitions so every
 * screen, section, component and action carries a valid, unique id. Split out of
 * definitionOps.ts for its size budget; definitionOps re-exports it.
 */

import { mapAllNodes, uniqueId } from '@shared/appDefinition/definitionOps.mjs';
import { ID_RE } from '@shared/appDefinition/ids.mjs';
import type { AppAction, AppDefinition, AppNode, AppScreen, AppSection } from '../inspector/appDefinition';

// ---------------------------------------------------------------------------
// ensureIds — repair AI-generated / imported definitions
// ---------------------------------------------------------------------------

/**
 * Guarantee every screen/section/component/action has a valid, globally
 * unique id (missing, malformed or duplicate ids get regenerated; the FIRST
 * occurrence of a duplicate keeps it). Internal references are rewritten
 * when the mapping old→new is unambiguous: homeScreenId, node onClick/
 * onSubmit, navigate.screenId (incl. effects navigateTo) and actionResult
 * bindings' actionId. Returns { def, changed }; same reference when clean.
 */
export function ensureIds(def: AppDefinition): { def: AppDefinition; changed: boolean } {
    const seen = new Set<string>();
    const AMBIGUOUS = Symbol('ambiguous');
    type Remap = Map<string, string | typeof AMBIGUOUS>;
    const screenRemap: Remap = new Map(); // oldId -> newId | AMBIGUOUS
    const actionRemap: Remap = new Map();
    let changed = false;

    const claim = (id: unknown, kind: string, remap: Remap | null): string => {
        if (typeof id === 'string' && ID_RE.test(id) && !seen.has(id)) {
            seen.add(id);
            return id;
        }
        const fresh: string = uniqueId(kind, seen);
        changed = true;
        if (remap && typeof id === 'string' && id) {
            remap.set(id, remap.has(id) ? AMBIGUOUS : fresh);
        }
        return fresh;
    };

    // Pass 1 — claim/regenerate ids top-down (structural sharing throughout).
    const claimTree = (children: AppNode[] | undefined): AppNode[] | undefined => {
        let dirty = false;
        const next = (children || []).map((child) => {
            const id = claim(child.id, 'component', null);
            const kids = Array.isArray(child.children) ? claimTree(child.children) : child.children;
            if (id === child.id && kids === child.children) return child;
            dirty = true;
            const node: AppNode = { ...child, id };
            if (kids !== child.children) node.children = kids;
            return node;
        });
        return dirty ? next : children;
    };
    let screensDirty = false;
    const claimedScreens = (def.screens || []).map((screen) => {
        const id = claim(screen.id, 'screen', screenRemap);
        let sectionsDirty = false;
        const sections = (screen.sections || []).map((section) => {
            const sid = claim(section.id, 'section', null);
            const children = claimTree(section.children);
            if (sid === section.id && children === section.children) return section;
            sectionsDirty = true;
            const next: AppSection = { ...section, id: sid };
            if (children !== section.children) next.children = children;
            return next;
        });
        if (id === screen.id && !sectionsDirty) return screen;
        screensDirty = true;
        return { ...screen, id, sections: sectionsDirty ? sections : screen.sections };
    });
    let actionsDirty = false;
    const actions: Record<string, AppAction> = {};
    for (const [key, action] of Object.entries(def.actions || {})) {
        const id = claim(key, 'action', actionRemap);
        if (id !== key) actionsDirty = true;
        actions[id] = action;
    }

    // A remap is only safe when the old id maps to exactly one new id AND is
    // no longer in use (duplicates keep their first occurrence — references
    // to a duplicated id still resolve, so they must not be rewritten).
    const resolve = (remap: Remap): Map<string, string> => {
        const out = new Map<string, string>();
        for (const [oldId, mapped] of remap) {
            if (mapped !== AMBIGUOUS && !seen.has(oldId)) out.set(oldId, mapped);
        }
        return out;
    };
    const screenMap = resolve(screenRemap);
    const actionMap = resolve(actionRemap);

    // Pass 2 — rewrite references (structural sharing continues: mapAllNodes
    // and the loops below return original objects when nothing changes).
    let next: AppDefinition = {
        ...def,
        screens: screensDirty ? claimedScreens : def.screens,
        actions: actionsDirty ? actions : def.actions,
    };

    if (actionMap.size) {
        next = mapAllNodes(next, (node: AppNode) => {
            let copy: AppNode | null = null;
            const ensure = (): AppNode => (copy = copy || { ...node });
            for (const event of ['onClick', 'onSubmit']) {
                if (actionMap.has(node[event] as string)) ensure()[event] = actionMap.get(node[event] as string);
            }
            // actionResult bindings live as direct prop values.
            for (const [key, value] of Object.entries(node.props || {})) {
                const binding = value as { kind?: unknown; actionId?: string } | null;
                if (value && typeof value === 'object' && binding?.kind === 'actionResult'
                    && actionMap.has(binding.actionId as string)) {
                    const target = ensure();
                    target.props = { ...(target.props || node.props), [key]: { ...binding, actionId: actionMap.get(binding.actionId as string) } };
                }
            }
            if (copy) changed = true;
            return copy || node;
        });
    }

    if (screenMap.size) {
        let refDirty = false;
        const rewritten: Record<string, AppAction> = {};
        for (const [id, action] of Object.entries(next.actions || {})) {
            let copy: AppAction = action;
            if (action.kind === 'navigate' && screenMap.has(action.screenId as string)) {
                copy = { ...copy, screenId: screenMap.get(action.screenId as string) };
            }
            for (const slot of ['onSuccess', 'onError']) {
                const effects = copy[slot] as { navigateTo?: unknown } | undefined;
                if (effects && screenMap.has(effects.navigateTo as string)) {
                    copy = { ...copy, [slot]: { ...effects, navigateTo: screenMap.get(effects.navigateTo as string) } };
                }
            }
            if (copy !== action) refDirty = true;
            rewritten[id] = copy;
        }
        if (refDirty) {
            next = { ...next, actions: rewritten };
            changed = true;
        }
    }

    // homeScreenId: follow the remap; if it still points nowhere, fall back
    // to the first screen so imported apps always have a renderable home.
    let homeScreenId: string | null | undefined = def.homeScreenId;
    if (screenMap.has(homeScreenId as string)) homeScreenId = screenMap.get(homeScreenId as string);
    const finalScreens: AppScreen[] = next.screens || [];
    if (!finalScreens.some((s) => s.id === homeScreenId) && finalScreens.length) {
        homeScreenId = finalScreens[0].id;
    }
    if (homeScreenId !== def.homeScreenId) {
        next = { ...next, homeScreenId };
        changed = true;
    }

    return changed ? { def: next, changed: true } : { def, changed: false };
}

/**
 * ensureIds: repair AI-generated or imported definitions. Port of the
 * "ensureIds" block of definitionOps.js.
 *
 * Every screen/section/component/action gets a valid, globally unique id
 * (missing, malformed or duplicate ids are regenerated; the FIRST occurrence
 * of a duplicate keeps it). References are rewritten when old -> new is
 * unambiguous: homeScreenId, node onClick/onSubmit, navigate.screenId, effects
 * navigateTo and actionResult bindings. Returns { def, changed }; the same def
 * when it was clean.
 */

import type { AppAction, AppDefinition, AppNode, AppScreen } from '../types';
import { ID_RE, type IdKind, uniqueId } from './ids';
import { mapAllNodes } from './tree';

const AMBIGUOUS = Symbol('ambiguous');
type Remap = Map<string, string | typeof AMBIGUOUS>;

class Claimer {
    readonly seen = new Set<string>();
    changed = false;

    claim(id: unknown, kind: IdKind, remap: Remap | null): string {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- ID_RE is anchored with one bounded class, ^(scr|sec|cmp|act)_[a-z0-9]{4,12}$, so it cannot backtrack
        if (typeof id === 'string' && ID_RE.test(id) && !this.seen.has(id)) {
            this.seen.add(id);
            return id;
        }
        const fresh = uniqueId(kind, this.seen);
        this.changed = true;
        if (remap && typeof id === 'string' && id) remap.set(id, remap.has(id) ? AMBIGUOUS : fresh);
        return fresh;
    }

    /** A remap is only safe when it is unambiguous AND the old id is no longer in use. */
    resolve(remap: Remap): Map<string, string> {
        const out = new Map<string, string>();
        for (const [oldId, mapped] of remap) {
            if (mapped !== AMBIGUOUS && !this.seen.has(oldId)) out.set(oldId, mapped);
        }
        return out;
    }
}

function claimTree(children: AppNode[], c: Claimer): AppNode[] {
    let dirty = false;
    const next = (children || []).map((child) => {
        const id = c.claim(child.id, 'component', null);
        const kids = Array.isArray(child.children) ? claimTree(child.children, c) : child.children;
        if (id === child.id && kids === child.children) return child;
        dirty = true;
        const node: AppNode = { ...child, id };
        if (kids !== child.children) node.children = kids;
        return node;
    });
    return dirty ? next : children;
}

function claimScreen(screen: AppScreen, c: Claimer, screenRemap: Remap): AppScreen {
    const id = c.claim(screen.id, 'screen', screenRemap);
    let sectionsDirty = false;
    const sections = (screen.sections || []).map((section) => {
        const sid = c.claim(section.id, 'section', null);
        const children = claimTree(section.children, c);
        if (sid === section.id && children === section.children) return section;
        sectionsDirty = true;
        const next = { ...section, id: sid };
        if (children !== section.children) next.children = children;
        return next;
    });
    if (id === screen.id && !sectionsDirty) return screen;
    return { ...screen, id, sections: sectionsDirty ? sections : screen.sections };
}

function claimActions(def: AppDefinition, c: Claimer, actionRemap: Remap): AppDefinition['actions'] {
    let dirty = false;
    const actions: Record<string, AppAction> = {};
    for (const [key, action] of Object.entries(def.actions || {})) {
        const id = c.claim(key, 'action', actionRemap);
        if (id !== key) dirty = true;
        actions[id] = action;
    }
    return dirty ? actions : def.actions;
}

function remapNodeRefs(node: AppNode, actionMap: Map<string, string>): AppNode | null {
    let copy: AppNode | null = null;
    const ensure = (): AppNode => (copy = copy || { ...node });
    for (const event of ['onClick', 'onSubmit'] as const) {
        const ref = node[event];
        if (typeof ref === 'string' && actionMap.has(ref)) ensure()[event] = actionMap.get(ref);
    }
    for (const [key, value] of Object.entries(node.props || {})) {
        const binding = value as { kind?: unknown; actionId?: unknown } | null;
        if (!binding || typeof binding !== 'object' || binding.kind !== 'actionResult') continue;
        if (!actionMap.has(binding.actionId as string)) continue;
        const target = ensure();
        target.props = { ...(target.props || node.props), [key]: { ...binding, actionId: actionMap.get(binding.actionId as string) } };
    }
    return copy;
}

function remapScreenRefs(action: AppAction, screenMap: Map<string, string>): AppAction {
    let copy = action;
    if (action.kind === 'navigate' && screenMap.has(action.screenId as string)) {
        copy = { ...copy, screenId: screenMap.get(action.screenId as string) };
    }
    for (const slot of ['onSuccess', 'onError'] as const) {
        const effects = copy[slot] as { navigateTo?: unknown } | undefined;
        if (effects && screenMap.has(effects.navigateTo as string)) {
            copy = { ...copy, [slot]: { ...effects, navigateTo: screenMap.get(effects.navigateTo as string) } };
        }
    }
    return copy;
}

function rewriteScreenRefs<D extends AppDefinition>(next: D, screenMap: Map<string, string>): D | null {
    let dirty = false;
    const rewritten: Record<string, AppAction> = {};
    for (const [id, action] of Object.entries(next.actions || {})) {
        const copy = remapScreenRefs(action, screenMap);
        if (copy !== action) dirty = true;
        rewritten[id] = copy;
    }
    return dirty ? { ...next, actions: rewritten } : null;
}

function fixHome<D extends AppDefinition>(def: D, next: D, screenMap: Map<string, string>): D | null {
    let homeScreenId = def.homeScreenId;
    if (homeScreenId !== undefined && screenMap.has(homeScreenId)) homeScreenId = screenMap.get(homeScreenId);
    const finalScreens = next.screens || [];
    if (!finalScreens.some((s) => s.id === homeScreenId) && finalScreens.length) {
        homeScreenId = (finalScreens[0] as AppScreen).id;
    }
    return homeScreenId !== def.homeScreenId ? { ...next, homeScreenId } : null;
}

export function ensureIds<D extends AppDefinition>(def: D): { def: D; changed: boolean } {
    const c = new Claimer();
    const screenRemap: Remap = new Map();
    const actionRemap: Remap = new Map();

    let screensDirty = false;
    const claimedScreens = (def.screens || []).map((screen) => {
        const out = claimScreen(screen, c, screenRemap);
        if (out !== screen) screensDirty = true;
        return out;
    });
    const actions = claimActions(def, c, actionRemap);
    const screenMap = c.resolve(screenRemap);
    const actionMap = c.resolve(actionRemap);

    let next: D = { ...def, screens: screensDirty ? claimedScreens : def.screens, actions };
    if (actionMap.size) {
        next = mapAllNodes(next, (node) => {
            const copy = remapNodeRefs(node, actionMap);
            if (copy) c.changed = true;
            return copy || node;
        });
    }
    const withScreens = screenMap.size ? rewriteScreenRefs(next, screenMap) : null;
    if (withScreens) {
        next = withScreens;
        c.changed = true;
    }
    const withHome = fixHome(def, next, screenMap);
    if (withHome) {
        next = withHome;
        c.changed = true;
    }
    return c.changed ? { def: next, changed: true } : { def, changed: false };
}

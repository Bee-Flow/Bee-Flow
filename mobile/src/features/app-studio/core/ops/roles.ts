/**
 * Roles and the presentational visibility gate (v2).
 *
 * The definition carries only role KEY references (screen/node
 * visibleToRoles) plus def.roles, a mirror of the data-model roles so
 * validation resolves them. Row-level security is the real boundary and lives
 * server-side; these ops only touch the presentational gate.
 * Port of the "Roles" block of definitionOps.js.
 */

import type { AppDefinition, AppNode, AppRole, AppScreen } from '../types';
import { findNode, findScreen, rewriteNode } from './tree';

/** Order-insensitive equality of two string-key arrays. */
function sameKeys(a: unknown, b: unknown): boolean {
    const A = Array.isArray(a) ? a : [];
    const B = Array.isArray(b) ? b : [];
    if (A.length !== B.length) return false;
    const setB = new Set(B);
    return A.every((k) => setB.has(k));
}

/** Dedupe and drop empties from a role-key list. */
function cleanRoleKeys(roleKeys: unknown): string[] {
    if (!Array.isArray(roleKeys)) return [];
    return [...new Set(roleKeys.filter((k): k is string => typeof k === 'string' && !!k))];
}

const gateOf = (target: { visibleToRoles?: unknown }): string[] =>
    Array.isArray(target.visibleToRoles) ? (target.visibleToRoles as string[]) : [];

/** The role keys currently gating a screen or node (empty = visible to all). */
export function getVisibleToRoles(def: AppDefinition | null | undefined, id: string): string[] {
    const screen = findScreen(def, id);
    if (screen) return gateOf(screen);
    const found = findNode(def, id);
    if (found) return gateOf(found.node);
    return [];
}

function withGate<T extends AppScreen | AppNode>(target: T, keys: string[]): T {
    const copy = { ...target };
    if (keys.length) copy.visibleToRoles = keys;
    else delete copy.visibleToRoles;
    return copy;
}

/**
 * Gate a screen or node (by id) to a set of role keys. An empty list CLEARS
 * the gate. Returns the same def when nothing changes.
 */
export function setVisibleToRoles<D extends AppDefinition>(def: D, id: string, roleKeys: unknown): D {
    const keys = cleanRoleKeys(roleKeys);
    const screens = def?.screens || [];
    const sIdx = screens.findIndex((s) => s.id === id);
    if (sIdx !== -1) {
        const screen = screens[sIdx] as AppScreen;
        if (sameKeys(gateOf(screen), keys)) return def;
        const nextScreens = screens.slice();
        nextScreens[sIdx] = withGate(screen, keys);
        return { ...def, screens: nextScreens };
    }
    const found = findNode(def, id);
    if (!found) return def;
    if (sameKeys(gateOf(found.node), keys)) return def;
    return rewriteNode(def, id, (node) => [withGate(node, keys)]).def;
}

/** The definition's mirrored role list ([{ id, name }]) or []. */
export function listDefinitionRoles(def: AppDefinition | null | undefined): AppRole[] {
    return Array.isArray(def?.roles) ? def.roles : [];
}

/**
 * Mirror the data-model roles ([{ key, label }]) into def.roles ([{ id, name }]).
 * Same def when the mirror is already in sync.
 */
export function setDefinitionRoles<D extends AppDefinition>(def: D, roles: unknown): D {
    const next = (Array.isArray(roles) ? roles : [])
        .filter((r) => r && typeof r.key === 'string' && r.key)
        .map((r) => ({ id: r.key as string, name: typeof r.label === 'string' && r.label ? (r.label as string) : r.key }));
    const current = listDefinitionRoles(def);
    const same =
        current.length === next.length && current.every((r, i) => r && r.id === next[i]?.id && r.name === next[i]?.name);
    if (same) return def;
    return { ...def, roles: next };
}

/**
 * Is a screen/node visible to `roleKey` under the presentational gate? A
 * missing/empty gate is everyone; a blank roleKey or 'owner' is the full view.
 */
export function isVisibleToRole(nodeOrScreen: { visibleToRoles?: unknown } | null | undefined, roleKey: unknown): boolean {
    if (!roleKey || roleKey === 'owner') return true;
    const gate = nodeOrScreen && nodeOrScreen.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return gate.includes(roleKey);
}

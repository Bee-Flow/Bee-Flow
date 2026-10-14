/**
 * App Studio — the presentational role gate and the declared variables of an
 * app definition. Split out of definitionOps.ts for its size budget; the
 * functions are re-exported from there unchanged.
 */

import { findNode, findScreen, rewriteNode } from '@shared/appDefinition/definitionOps.mjs';
import type { AppDefinition, AppNode, AppScreen } from '../inspector/appDefinition';

/** One declared variable: a `name` plus whatever else the author set. */
export interface VariableDef {
    name?: string;
    [key: string]: unknown;
}

/** One role reference in def.roles. */
export interface RoleRef {
    id: string;
    name: string;
}

// ---------------------------------------------------------------------------
// Roles / presentational visibility gating (v2)
// ---------------------------------------------------------------------------
//
// The DEFINITION carries only role KEY references — screen.visibleToRoles and
// node.visibleToRoles (arrays of role keys) plus def.roles ([{ id, name }], a
// mirror of the authoritative data-model roles so validation resolves the
// references). The actual role definitions + row-level security live server-
// side in the data model; these ops only touch the presentational gate.

/** Order-insensitive equality of two string-key arrays. */
function sameKeys(a: unknown, b: unknown): boolean {
    const A: unknown[] = Array.isArray(a) ? a : [];
    const B: unknown[] = Array.isArray(b) ? b : [];
    if (A.length !== B.length) return false;
    const setB = new Set<unknown>(B);
    return A.every((k) => setB.has(k));
}

/** Dedupe + drop empties from a role-key list. */
function cleanRoleKeys(roleKeys: unknown): string[] {
    if (!Array.isArray(roleKeys)) return [];
    return [...new Set(roleKeys.filter((k): k is string => typeof k === 'string' && Boolean(k)))];
}

/** The role keys currently gating a screen or node (empty = visible to all). */
export function getVisibleToRoles(def: AppDefinition, id: string): string[] {
    const screen: AppScreen | undefined = findScreen(def, id);
    if (screen) return Array.isArray(screen.visibleToRoles) ? (screen.visibleToRoles as string[]) : [];
    const found = findNode(def, id);
    if (found) return Array.isArray(found.node.visibleToRoles) ? (found.node.visibleToRoles as string[]) : [];
    return [];
}

/**
 * Gate a screen or node (by id) to a set of role keys. An empty/blank list
 * CLEARS the gate (deletes visibleToRoles → visible to everyone). Returns the
 * same def reference when nothing changes, so callers can `!==`-check.
 */
export function setVisibleToRoles(def: AppDefinition, id: string, roleKeys: unknown): AppDefinition {
    const keys = cleanRoleKeys(roleKeys);

    // Screen?
    const screens: AppScreen[] = def?.screens || [];
    const sIdx = screens.findIndex((s) => s.id === id);
    if (sIdx !== -1) {
        const current = Array.isArray(screens[sIdx].visibleToRoles) ? (screens[sIdx].visibleToRoles as string[]) : [];
        if (sameKeys(current, keys)) return def;
        const nextScreen: AppScreen = { ...screens[sIdx] };
        if (keys.length) nextScreen.visibleToRoles = keys;
        else delete nextScreen.visibleToRoles;
        const nextScreens = screens.slice();
        nextScreens[sIdx] = nextScreen;
        return { ...def, screens: nextScreens };
    }

    // Node?
    const found = findNode(def, id);
    if (!found) return def;
    const current = Array.isArray(found.node.visibleToRoles) ? (found.node.visibleToRoles as string[]) : [];
    if (sameKeys(current, keys)) return def;
    const { def: next } = rewriteNode(def, id, (node: AppNode) => {
        const copy: AppNode = { ...node };
        if (keys.length) copy.visibleToRoles = keys;
        else delete copy.visibleToRoles;
        return [copy];
    });
    return next;
}

/** The definition's mirrored role list ([{ id, name }]) or []. */
export function listDefinitionRoles(def: AppDefinition | null | undefined): RoleRef[] {
    return Array.isArray(def?.roles) ? (def.roles as RoleRef[]) : [];
}

/**
 * Mirror the authoritative data-model roles ([{ key, label }]) into
 * def.roles ([{ id, name }]) so screen/node visibleToRoles references resolve
 * (and the AI builder + validation see the same role vocabulary). Returns the
 * same def reference when the mirror is already in sync.
 */
export function setDefinitionRoles(def: AppDefinition, roles: unknown): AppDefinition {
    const source: Array<{ key?: unknown; label?: unknown }> = Array.isArray(roles) ? roles : [];
    const next: RoleRef[] = source
        .filter((r) => r && typeof r.key === 'string' && r.key)
        .map((r) => ({ id: r.key as string, name: (typeof r.label === 'string' && r.label) ? r.label as string : r.key as string }));
    const current = listDefinitionRoles(def);
    const same = current.length === next.length
        && current.every((r, i) => r && r.id === next[i].id && r.name === next[i].name);
    if (same) return def;
    return { ...def, roles: next };
}

// ── Variables (definition.variables) ────────────────────────────────────────
// EMIT-WHEN-PRESENT, like design/nav: an app that declares none must round-trip
// to exactly the bytes it had before the key existed, or every shipped
// template's "no structural repairs" contract shifts on the next save.

/** The definition's declared variables, or []. */
export function listVariables(def: AppDefinition | null | undefined): VariableDef[] {
    return Array.isArray(def?.variables) ? (def.variables as VariableDef[]) : [];
}

/**
 * Add or patch one variable, matched by `name`. A new name is appended; an
 * existing one is shallow-merged in place so the list order survives an edit.
 * Returns the same def reference when nothing actually changes.
 */
export function setVariable(def: AppDefinition, variable: VariableDef | null | undefined): AppDefinition {
    if (!variable || typeof variable.name !== 'string' || !variable.name) return def;
    const current = listVariables(def);
    const at = current.findIndex((v) => v?.name === variable.name);
    const next: VariableDef[] = at === -1
        ? [...current, variable]
        : current.map((v, i) => (i === at ? { ...v, ...variable } : v));
    const unchanged = at !== -1
        && Object.keys(variable).every((k) => shallowSame(current[at][k], variable[k]));
    if (unchanged) return def;
    return { ...def, variables: next };
}

/**
 * Rename a variable in place, keeping its position. Nothing REWRITES the
 * formulas that read it — the manager only offers a rename while a variable is
 * unused, for exactly that reason.
 */
export function renameVariable(def: AppDefinition, from: string, to: string | null | undefined): AppDefinition {
    if (typeof to !== 'string' || !to || from === to) return def;
    const current = listVariables(def);
    if (!current.some((v) => v?.name === from)) return def;
    if (current.some((v) => v?.name === to)) return def;   // a name is unique
    return { ...def, variables: current.map((v) => (v?.name === from ? { ...v, name: to } : v)) };
}

/**
 * Remove a variable. Removing the LAST one deletes the key entirely, so a
 * created-then-deleted round trip is byte-clean (mirrors updateDesign(def, null)).
 */
export function removeVariable(def: AppDefinition, name: string): AppDefinition {
    const current = listVariables(def);
    const next = current.filter((v) => v?.name !== name);
    if (next.length === current.length) return def;
    if (next.length === 0) {
        const { variables: _dropped, ...rest } = def;
        return rest;
    }
    return { ...def, variables: next };
}

/** Cheap equality for a variable field (defaults may be objects or arrays). */
function shallowSame(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * Is a screen/node visible to `roleKey` under the presentational gate?
 * A missing/empty visibleToRoles means "everyone"; a null/blank roleKey or the
 * owner sentinel means "no gating" (full view). Pure — the renderer uses this
 * for the editor's view-as-role preview (row security is the real boundary).
 */
export function isVisibleToRole(nodeOrScreen: { visibleToRoles?: unknown } | null | undefined, roleKey: string | null | undefined): boolean {
    if (!roleKey || roleKey === 'owner') return true;
    const gate = nodeOrScreen && nodeOrScreen.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return (gate as unknown[]).includes(roleKey);
}


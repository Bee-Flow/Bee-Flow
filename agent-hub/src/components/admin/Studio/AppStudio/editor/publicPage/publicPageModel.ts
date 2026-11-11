/**
 * The public page of an app, as the publish modal edits and explains it: the
 * `publicAccess` block of the definition (server appStudio/publicAccess.js) and
 * what an anonymous visitor can reach through it. Pure: no React, no fetch.
 *
 * The block the server canonicalizes to, in this key order:
 *
 *   { entryScreenId, screenIds, roleKey: 'public', title?, theme?, design? }
 *
 * Every writer here produces exactly that shape, so a block written by the
 * editor canonicalizes byte-identically to itself. `theme` and `design` are
 * PARTIAL overrides merged over the app's look on the public page only; a knob
 * set to null is "same as the app" and is left out, and an empty override is
 * left out as a whole.
 *
 * What a visitor reaches mirrors the server's own reading
 * (resolvePublicSurface and buildPublicDefinition; pinned by
 * publicPageModel.lockstep.test.ts):
 *   screens — the listed screens, nothing else;
 *   actions — the actions a component on those screens runs, plus the actions
 *             those call (call_action), which run only through their caller;
 *   tables  — only what a table grants the reserved role `public` explicitly.
 */

import { childStepSlots } from '@shared/appDefinition/stepFlow.mjs';
import type { AppDefinition, AppScreen } from '../../inspector/appDefinition';
import { NODE_EVENTS } from '../../state/definitionOps';
import { PUBLIC_ROLE_KEY, tableGrant } from '../publishAccessSummary';
import type { AccessTable, TableGrant } from '../publishAccessSummary';

/** At most this many screens on one public page (server MAX_PUBLIC_SCREENS). */
export const MAX_PUBLIC_SCREENS = 12;
/** At most this many live URLs per app (server routes/studioApps/publicPages.js). */
export const MAX_PUBLIC_URLS = 3;
/** The browser title is cut at this length by the canonicalizer. */
export const MAX_PUBLIC_TITLE = 200;

export type LookPart = 'theme' | 'design';
type LookOverride = Record<string, string>;

export interface PublicAccess {
    entryScreenId: string;
    screenIds: string[];
    roleKey: string;
    title?: string;
    theme?: LookOverride;
    design?: LookOverride;
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function stringOverride(raw: unknown): LookOverride | undefined {
    if (!isObject(raw)) return undefined;
    const out: LookOverride = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
    return Object.keys(out).length ? out : undefined;
}

/** The definition's public block, read defensively; null when the app has none. */
export function readPublicAccess(definition: AppDefinition | null | undefined): PublicAccess | null {
    const raw = definition?.publicAccess;
    if (!isObject(raw) || typeof raw.entryScreenId !== 'string' || !raw.entryScreenId) return null;
    const ids = Array.isArray(raw.screenIds) ? raw.screenIds.filter((s): s is string => typeof s === 'string' && !!s) : [];
    return build({
        entryScreenId: raw.entryScreenId,
        screenIds: ids.includes(raw.entryScreenId) ? ids : [raw.entryScreenId, ...ids],
        title: typeof raw.title === 'string' ? raw.title : undefined,
        theme: stringOverride(raw.theme),
        design: stringOverride(raw.design),
    });
}

/** The canonical shape, keys in the canonicalizer's order, empty parts left out. */
function build(p: Omit<PublicAccess, 'roleKey'> & { roleKey?: string }): PublicAccess {
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, MAX_PUBLIC_TITLE) : '';
    return {
        entryScreenId: p.entryScreenId,
        screenIds: p.screenIds,
        roleKey: PUBLIC_ROLE_KEY,
        ...(title ? { title } : {}),
        ...(p.theme && Object.keys(p.theme).length ? { theme: p.theme } : {}),
        ...(p.design && Object.keys(p.design).length ? { design: p.design } : {}),
    };
}

/**
 * The definition with this public block, or without one (null): the key goes
 * away entirely, so closing the page leaves the definition as it was before
 * it was ever opened. Returns the same reference when nothing changes.
 */
export function withPublicAccess(definition: AppDefinition, next: PublicAccess | null): AppDefinition {
    const current = definition.publicAccess;
    if (!next) {
        if (current === undefined) return definition;
        const { publicAccess: _dropped, ...rest } = definition;
        return rest;
    }
    if (JSON.stringify(current) === JSON.stringify(next)) return definition;
    return { ...definition, publicAccess: next };
}

/** A first public block: the app's home screen (or its first) as the only screen. */
export function openPublicAccess(definition: AppDefinition | null | undefined): PublicAccess | null {
    const screens = definition?.screens || [];
    const home = screens.find((s) => s.id === definition?.homeScreenId) || screens[0];
    return home ? build({ entryScreenId: home.id, screenIds: [home.id] }) : null;
}

/** Add or remove one screen. The entry screen stays, and the cap holds. */
export function toggleScreen(pa: PublicAccess, screenId: string): PublicAccess {
    if (screenId === pa.entryScreenId) return pa;
    if (pa.screenIds.includes(screenId)) return build({ ...pa, screenIds: pa.screenIds.filter((id) => id !== screenId) });
    if (pa.screenIds.length >= MAX_PUBLIC_SCREENS) return pa;
    return build({ ...pa, screenIds: [...pa.screenIds, screenId] });
}

/** Land visitors on another of the listed screens. */
export function setEntryScreen(pa: PublicAccess, screenId: string): PublicAccess {
    if (!pa.screenIds.includes(screenId) || screenId === pa.entryScreenId) return pa;
    return build({ ...pa, entryScreenId: screenId });
}

export function setTitle(pa: PublicAccess, title: string): PublicAccess {
    return build({ ...pa, title });
}

/** Override one knob of the page's look, or (null) take the app's value again. */
export function setLookKnob(pa: PublicAccess, part: LookPart, key: string, value: string | null): PublicAccess {
    const current: LookOverride = { ...(pa[part] || {}) };
    if (value === null || value === '') delete current[key];
    else current[key] = value;
    return build({ ...pa, [part]: current });
}

// ── What an anonymous visitor reaches ─────────────────────────────────

const ACTION_LIST_PROPS = ['itemActions', 'rowActions', 'bulkActions', 'toolbarActions'];

/** The actions one node runs: its events, the four action lists, addRowActionId, columns[].actionId. */
function nodeActionIds(node: Obj): string[] {
    const out: string[] = [];
    for (const ev of NODE_EVENTS) if (typeof node[ev] === 'string' && node[ev]) out.push(node[ev] as string);
    const props = isObject(node.props) ? node.props : {};
    const entries = [...ACTION_LIST_PROPS.flatMap((k) => (Array.isArray(props[k]) ? props[k] as unknown[] : [])),
        ...(Array.isArray(props.columns) ? props.columns as unknown[] : [])];
    for (const e of entries) if (isObject(e) && typeof e.actionId === 'string' && e.actionId) out.push(e.actionId);
    if (typeof props.addRowActionId === 'string' && props.addRowActionId) out.push(props.addRowActionId);
    return out;
}

function wiredActions(screens: AppScreen[]): Set<string> {
    const out = new Set<string>();
    const visit = (node: unknown) => {
        if (!isObject(node)) return;
        for (const id of nodeActionIds(node)) out.add(id);
        for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
    };
    for (const screen of screens) {
        for (const section of Array.isArray(screen.sections) ? screen.sections : []) {
            for (const child of Array.isArray(section?.children) ? section.children : []) visit(child);
        }
    }
    return out;
}

// The server's bounds (componentSpecs/limits.js): call_action hops below a
// public root, and the step nesting a walk follows (MAX_ACTION_DEPTH + 1).
const MAX_CALL_HOPS = 3;
const MAX_STEP_NESTING = 9;

/** The ids one action calls through call_action. */
function calleesOf(action: unknown): string[] {
    const out: string[] = [];
    const walk = (list: unknown[], depth: number) => {
        for (const step of list) {
            if (!isObject(step)) continue;
            if (step.kind === 'call_action' && typeof step.actionId === 'string') out.push(step.actionId);
            if (depth >= MAX_STEP_NESTING) continue;
            for (const slot of childStepSlots(step)) walk(slot.steps, depth + 1);
        }
    };
    if (isObject(action)) walk(action.kind === 'sequence' ? (Array.isArray(action.steps) ? action.steps : []) : [action], 1);
    return out;
}

/** The actions `roots` call, hop by hop, that are not roots themselves. */
function calledFrom(all: Obj, roots: string[]): string[] {
    const seen = new Set(roots);
    const called: string[] = [];
    let frontier = roots;
    for (let hop = 0; frontier.length && hop < MAX_CALL_HOPS; hop += 1) {
        const next: string[] = [];
        for (const id of frontier) {
            for (const callee of calleesOf(Object.hasOwn(all, id) ? all[id] : null)) {
                if (seen.has(callee)) continue;
                seen.add(callee);
                next.push(callee);
                if (Object.hasOwn(all, callee)) called.push(callee);
            }
        }
        frontier = next;
    }
    return called;
}

export interface PublicReach {
    screens: Array<{ id: string; name: string; entry: boolean }>;
    /** Actions a component on a listed screen runs. */
    actions: string[];
    /** Actions those call; they run only as part of their caller. */
    calledActions: string[];
}

/** What a visitor of this public block reaches in the definition. */
export function publicReach(definition: AppDefinition | null | undefined, pa: PublicAccess | null): PublicReach {
    if (!pa || !definition) return { screens: [], actions: [], calledActions: [] };
    const listed = (definition.screens || []).filter((s) => pa.screenIds.includes(s.id));
    const all = isObject(definition.actions) ? definition.actions as Obj : {};
    const roots = [...wiredActions(listed)];
    return {
        screens: listed.map((s) => ({ id: s.id, name: s.name || s.id, entry: s.id === pa.entryScreenId })),
        actions: roots.filter((id) => Object.hasOwn(all, id)),
        calledActions: calledFrom(all, roots),
    };
}

/** Each table that grants the public role anything, with that grant. */
export function publicTableGrants(tables: AccessTable[] | null | undefined): Array<{ table: AccessTable; grant: TableGrant }> {
    return (Array.isArray(tables) ? tables : [])
        .map((table) => ({ table, grant: tableGrant(table, PUBLIC_ROLE_KEY) }))
        .filter(({ grant }) => grant.read !== 'none' || grant.update !== 'none' || grant.remove !== 'none' || grant.create);
}

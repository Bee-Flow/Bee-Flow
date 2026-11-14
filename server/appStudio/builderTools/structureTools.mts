/**
 * App Studio builder: rearranging what exists. app_remove_section, app_move_section and
 * app_reorder_screens, on the shared structure ops (shared/appDefinition/structureOps.mjs, the
 * ones the editor uses), through canonicalize like every edit tool (adoptCanonical).
 *
 *   app_remove_section   removes a section with its components. Like app_remove_node it
 *                        removes and REPORTS what still names a removed component (an action,
 *                        another component, a public setting), so the model can fix those.
 *                        A screen keeps at least one section.
 *   app_move_section     a new place among the sections of its own screen (as in the editor).
 *   app_reorder_screens  the screens in a new order, given as the full list of screen ids.
 */

import { createRequire } from 'node:module';
import { pickClosestId } from '../../utils/closestId.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Node = Obj & { id?: string; children?: Node[] };
type Section = Obj & { id?: string; children?: Node[] };
type Screen = Obj & { id?: string; name?: string; sections?: Section[] };
type Def = Obj & { screens?: Screen[]; actions?: Record<string, unknown>; nav?: { groups?: unknown[] }; homeScreenId?: unknown };
type Draft = { def: Def } & Obj;
type Result = Obj & { error?: string; _fixHint?: string; _hints?: string[] };

const ops = nodeRequire('../definitionOps') as {
    findSection: (def: Def, id: unknown) => { screen: Screen; section: Section; index: number } | null;
    moveSection: (def: Def, id: string, index: number) => Def;
};
const { adoptCanonical, idHint } = nodeRequire('./shared') as { adoptCanonical: (d: Draft, next: Def, r: Result) => Result; idHint: (def: Def) => string };

const MAX_LISTED = 12;

const screensOf = (def: Def): Screen[] => (Array.isArray(def.screens) ? def.screens : []);

function unknownSection(def: Def, sectionId: unknown): Result {
    const all = screensOf(def).flatMap((s) => (s.sections || []).map((sec) => String(sec.id)));
    const suggestion = pickClosestId(sectionId, all);
    return { error: `Unknown sectionId ${JSON.stringify(sectionId ?? null)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: idHint(def) };
}

function nodeIds(nodes: Node[] | undefined, out: string[] = []): string[] {
    for (const n of Array.isArray(nodes) ? nodes : []) {
        if (typeof n?.id === 'string') out.push(n.id);
        nodeIds(n?.children, out);
    }
    return out;
}

/** Where the definition outside `skip` still names one of `ids` (an exact id inside a value or a formula). */
function referencesTo(def: Def, ids: string[], skip: Section): string[] {
    if (!ids.length) return [];
    const names = (value: unknown): boolean => { const text = JSON.stringify(value) ?? ''; return ids.some((id) => text.includes(id)); };
    const out: string[] = [];
    for (const [id, action] of Object.entries(def.actions || {})) if (names(action)) out.push(`action ${id}`);
    const walk = (nodes: Node[] | undefined): void => {
        for (const n of Array.isArray(nodes) ? nodes : []) {
            const { children, ...own } = n;
            if (names(own)) out.push(`component ${String(n.id)}`);
            walk(children);
        }
    };
    for (const screen of screensOf(def)) {
        const { sections, ...own } = screen;
        if (names(own)) out.push(`screen ${String(screen.id)}`);
        for (const sec of sections || []) {
            if (sec === skip) continue;
            const { children, ...secOwn } = sec;
            if (names(secOwn)) out.push(`section ${String(sec.id)}`);
            walk(children);
        }
    }
    for (const [key, value] of Object.entries(def)) if (key !== 'screens' && key !== 'actions' && names(value)) out.push(key);
    return out;
}

/** app_remove_section { sectionId } */
export function applyRemoveSection(draftWrap: Draft, args: unknown): Result {
    const a = (args && typeof args === 'object' ? args : {}) as Obj;
    const def = draftWrap.def;
    const found = ops.findSection(def, a.sectionId);
    if (!found) return unknownSection(def, a.sectionId);
    const sections = found.screen.sections || [];
    if (sections.length <= 1) {
        return {
            error: `${String(found.section.id)} is the only section of screen ${String(found.screen.id)}; a screen keeps at least one.`,
            _fixHint: 'Remove its components with app_remove_node, or remove the whole screen with app_remove_screen.',
        };
    }
    const removed = nodeIds(found.section.children);
    const refs = referencesTo(def, removed, found.section);
    const screens = screensOf(def).map((s) => (s === found.screen ? { ...s, sections: sections.filter((sec) => sec !== found.section) } : s));
    const result = adoptCanonical(draftWrap, { ...def, screens }, { removed: found.section.id, screenId: found.screen.id, removedComponents: removed.length });
    if (result.error) return result;
    if (refs.length) {
        result.stillReferenced = refs.slice(0, MAX_LISTED);
        result._hints = [...(result._hints || []), `These still name a component that was in the removed section: ${refs.slice(0, MAX_LISTED).join(', ')}${refs.length > MAX_LISTED ? ', …' : ''}. Point them elsewhere or remove them (app_update_step, app_set_action, app_update_component), or they fail at the next check.`];
    }
    return result;
}

/** app_move_section { sectionId, index } */
export function applyMoveSection(draftWrap: Draft, args: unknown): Result {
    const a = (args && typeof args === 'object' ? args : {}) as Obj;
    const def = draftWrap.def;
    const found = ops.findSection(def, a.sectionId);
    if (!found) return unknownSection(def, a.sectionId);
    if (!Number.isInteger(a.index) || (a.index as number) < 0) {
        return { error: 'index must be a whole number from 0: the place among the sections of its screen (0 is the top).', _fixHint: `Screen ${String(found.screen.id)} has ${(found.screen.sections || []).length} sections.` };
    }
    const sectionId = String(found.section.id);
    const next = ops.moveSection(def, sectionId, a.index as number);
    const order = (s: Def): string[] => (ops.findSection(s, sectionId)?.screen.sections || []).map((sec) => String(sec.id));
    if (next === def) return { moved: sectionId, screenId: found.screen.id, order: order(def), note: 'No change: the section was already at that place.' };
    const result = adoptCanonical(draftWrap, next, { moved: sectionId, screenId: found.screen.id });
    if (!result.error) result.order = order(draftWrap.def);
    return result;
}

/** app_reorder_screens { screenIds } */
export function applyReorderScreens(draftWrap: Draft, args: unknown): Result {
    const a = (args && typeof args === 'object' ? args : {}) as Obj;
    const def = draftWrap.def;
    const screens = screensOf(def);
    const current = screens.map((s) => String(s.id));
    const ids = Array.isArray(a.screenIds) ? a.screenIds : null;
    const hint = `Pass every screen id once, in the new order. The current order: ${current.join(', ')}.`;
    if (!ids || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !current.includes(id))) {
        return { error: 'screenIds must list every screen of the app exactly once.', _fixHint: hint };
    }
    if (ids.every((id, i) => id === current[i])) return { order: current, note: 'No change: the screens were already in this order.' };
    const byId = new Map(screens.map((s) => [String(s.id), s]));
    const result = adoptCanonical(draftWrap, { ...def, screens: (ids as string[]).map((id) => byId.get(id) as Screen) }, { order: ids });
    if (result.error) return result;
    result.homeScreenId = draftWrap.def.homeScreenId ?? null;
    if (Array.isArray(def.nav?.groups) && def.nav.groups.length) {
        result._hints = [...(result._hints || []), 'The app menu is grouped (nav.groups): the groups keep their own order of screens; change it with app_set_nav_groups.'];
    }
    return result;
}

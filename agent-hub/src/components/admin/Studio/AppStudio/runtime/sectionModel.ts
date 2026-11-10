import { compile, tryEvaluate } from '@shared/expr/engine.mjs';
import { evalBoolFlag } from './nodeVisibility';
import type { FlagInput } from './AppRenderer.types';

/**
 * The optional keys of a section (server/appStudio/componentSpecs/keys/section/), as the runtime
 * reads them. Every one is absent on a section that does not use it, and then nothing here adds a
 * class, an element or a check: such a section renders and loads exactly as before.
 *
 *   title           a heading inside the section, above its components
 *   collapsible     the viewer folds the section by clicking that title
 *   maxWidth        narrow | medium | wide caps and centres the section (full = the screen's width)
 *   visibleWhen     a hidden section renders nothing (the editor dims it instead)
 *   visibleToRoles  the same rule as a node's, read against the viewer's role
 *   name            a builder-only label (the editor's section chip)
 */
export interface SectionModel {
    id?: string;
    style?: unknown;
    children?: unknown[];
    name?: unknown;
    title?: unknown;
    collapsible?: unknown;
    maxWidth?: unknown;
    visibleWhen?: FlagInput;
    visibleToRoles?: unknown;
}

/** The width caps; `full` (and the absent key) take the screen's width. */
const MAX_WIDTH_CLASSES: Readonly<Record<string, string>> = Object.freeze({
    narrow: ' app-section-max-narrow',
    medium: ' app-section-max-medium',
    wide: ' app-section-max-wide',
});

/**
 * The scope roots the data layer fills the same way the renderer does. A section condition that
 * reads only these is judged before its components' data is fetched; one that reads anything
 * else (an action result, loaded rows) is not, and its data loads as before.
 */
const FETCH_SCOPE_ROOTS: ReadonlySet<string> = new Set(['currentUser', 'vars', 'forms', 'form', 'screen', 'now', 'today']);

const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The section's title, or '' for none. */
export function sectionTitle(section: SectionModel | null | undefined): string {
    return textOf(section?.title);
}

/** The builder-only name, or '' for none. */
export function sectionName(section: SectionModel | null | undefined): string {
    return textOf(section?.name);
}

/** True when the viewer may fold the section (it needs a title to click). */
export function sectionCollapsible(section: SectionModel | null | undefined): boolean {
    return section?.collapsible === true && !!sectionTitle(section);
}

/** The class a width cap adds, or ''. */
export function sectionWidthClass(section: SectionModel | null | undefined): string {
    const value = section?.maxWidth;
    return typeof value === 'string' && Object.hasOwn(MAX_WIDTH_CLASSES, value) ? MAX_WIDTH_CLASSES[value] : '';
}

/**
 * The role gate, as AppRenderer's roleAllows reads a node's: no role (the editor without a
 * previewed role) or the owner sees every section; an absent or empty list is open.
 */
export function sectionRoleAllows(section: SectionModel | null | undefined, role: string | null | undefined): boolean {
    if (!role || role === 'owner') return true;
    const gate = section?.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return gate.includes(role);
}

/** { hidden, error } of section.visibleWhen against the live scope. */
export function sectionVisibility(section: SectionModel | null | undefined, scope: object): { hidden: boolean; error: string | null } {
    const when = evalBoolFlag(section?.visibleWhen, scope as Parameters<typeof evalBoolFlag>[1]);
    if (!when.set) return { hidden: false, error: null };
    return { hidden: !when.value, error: (when as { error?: string | null }).error ?? null };
}

/** True when the section carries a gate the data layer has to read. */
export function sectionHasGate(section: SectionModel | null | undefined): boolean {
    return section?.visibleWhen != null || (Array.isArray(section?.visibleToRoles) && section.visibleToRoles.length > 0);
}

/** A condition the data layer can decide: false (skip the section) only when it is sure. */
function conditionAllowsFetch(flag: FlagInput, scope: object): boolean {
    if (flag === undefined || flag === null) return true;
    if (typeof flag === 'boolean') return flag;
    const expr = typeof flag === 'object' ? (flag.expr ?? flag.value) : flag;
    if (typeof expr !== 'string' || !expr.trim()) return true;
    let refs: string[];
    try {
        refs = (compile(expr) as { refs: string[] }).refs;
    } catch {
        return true;
    }
    if (!refs.every((r) => FETCH_SCOPE_ROOTS.has(r))) return true;
    const result = tryEvaluate(expr, scope) as { value?: unknown; error?: unknown };
    return result.error ? true : !!result.value;
}

/**
 * Whether the data of a section's components is fetched for this viewer: not when its role gate
 * closes, nor when its condition is false on roots the fetch scope holds. Anything this cannot
 * decide loads, so a section the renderer shows never waits on data nobody fetched.
 */
export function sectionLoadsData(section: SectionModel | null | undefined, scope: object, role: string | null | undefined): boolean {
    if (!sectionRoleAllows(section, role)) return false;
    return conditionAllowsFetch(section?.visibleWhen, scope);
}

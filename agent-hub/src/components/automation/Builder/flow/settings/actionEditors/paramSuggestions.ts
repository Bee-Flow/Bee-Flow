// A suggestion for every EMPTY required setting of an app action (round 4,
// artboard 4b: "Which folder? · Root folder / · suggestion"): first a field
// of an earlier step that fits (the auto-mapper's own matching), otherwise a
// safe default: the root folder for a folder or path, today for a date.
// Never applied on its own: the drawer shows it, the author clicks it.
import { humanizeFieldTail } from '../../displayHelpers';

export interface Suggestion {
    binding: { kind: string; value?: unknown; path?: string };
    label: string;
    source: 'field' | 'default';
}

interface SchemaProp { type?: string | string[]; format?: string; title?: string }
interface InputSchema { properties?: Record<string, SchemaProp>; required?: string[] }
interface Group { label: string; basePath: string }
type Tr = (key: string, en: string, params?: Record<string, unknown>) => string;

const isEmpty = (b: unknown): boolean => {
    if (b == null) return true;
    if (typeof b !== 'object') return false;
    const v = b as { kind?: string; value?: unknown; path?: string };
    if (v.kind === 'literal') return v.value == null || v.value === '';
    if (v.kind === 'ref') return !v.path;
    return !v.value;
};

const typeOf = (p: SchemaProp | undefined) => (Array.isArray(p?.type) ? p?.type.find(x => x !== 'null') : p?.type);

/** "Step label › Field" for a ref path, from the group that holds it. */
export function refLabel(path: string, groups: Group[]): string {
    const group = [...groups].sort((a, b) => b.basePath.length - a.basePath.length)
        .find(g => path === g.basePath || path.startsWith(`${g.basePath}.`) || path.startsWith(`${g.basePath}[`));
    const tail = (humanizeFieldTail as (p: string) => string)(path) || path;
    return group ? `${group.label} › ${tail}` : tail;
}

/** A safe default for a setting nobody mapped, or null when there is none. */
export function safeDefault(key: string, prop: SchemaProp | undefined, t: Tr, today: Date = new Date()): Suggestion | null {
    const type = typeOf(prop);
    const fmt = String(prop?.format || '').toLowerCase();
    if (fmt === 'date' || fmt === 'date-time') {
        const iso = today.toISOString().slice(0, 10);
        return { binding: { kind: 'literal', value: iso }, label: t('automations.ndv.suggest_today', 'Today ({date})', { date: iso }), source: 'default' };
    }
    if (type && type !== 'string') return null;
    const words = `${key} ${prop?.title || ''}`.toLowerCase();
    if (/folder|directory|\bdir\b|dir_?path|parent/.test(words)) {
        return { binding: { kind: 'literal', value: '/' }, label: t('automations.ndv.suggest_root', 'Root folder /'), source: 'default' };
    }
    return null;
}

export function buildParamSuggestions(
    schema: InputSchema | null,
    inputs: Record<string, unknown>,
    groups: Group[],
    autoMap: (schema: unknown, inputs: unknown, groups: unknown) => Record<string, unknown>,
    t: Tr,
): Record<string, Suggestion> {
    const props = schema?.properties || {};
    const required = (schema?.required || []).filter(k => k in props && isEmpty(inputs?.[k]));
    if (!required.length) return {};
    let mapped: Record<string, unknown> = {};
    try { mapped = autoMap(schema, inputs || {}, groups || []) || {}; } catch { mapped = {}; }
    const out: Record<string, Suggestion> = {};
    for (const key of required) {
        const b = mapped[key] as { kind?: string; path?: string } | undefined;
        if (b && b.kind === 'ref' && b.path) {
            out[key] = { binding: { kind: 'ref', path: b.path }, label: refLabel(b.path, groups || []), source: 'field' };
            continue;
        }
        const d = safeDefault(key, props[key], t);
        if (d) out[key] = d;
    }
    return out;
}

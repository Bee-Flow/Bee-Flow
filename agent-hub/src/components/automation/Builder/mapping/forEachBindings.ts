/**
 * A step's fields as ONE map of slots, for re-pointing its "run once per
 * item" list (loopLists.pickLoopList): what reads `loop.<item>` may sit in
 * `inputs`, in a Set's `fields`, in a table row's `values`, or in plain text
 * such as a prompt or a notification title. The entries of those maps become
 * slots of their own, so a note can say "Message id" rather than "inputs".
 */

/** Maps whose entries are the step's fields, one binding per entry. */
const FIELD_MAPS = ['inputs', 'fields', 'values'];
/** Keys that never hold a reference to the item. */
const SKIP = new Set(['forEach', 'id', 'type', 'tool', 'appId', 'label', 'icon', 'retry', 'askOnce', 'autoMapped', 'position']);

type Draft = Record<string, unknown>;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { kind?: unknown }).kind !== 'string';

interface Slot { key: string; map: string | null }

function slotsOf(draft: Draft): Map<string, Slot> {
    const slots = new Map<string, Slot>();
    for (const [k, v] of Object.entries(draft || {})) {
        if (SKIP.has(k)) continue;
        if (FIELD_MAPS.includes(k) && isMap(v)) {
            for (const entry of Object.keys(v)) slots.set(slots.has(entry) ? `${k}.${entry}` : entry, { key: entry, map: k });
        } else {
            slots.set(slots.has(k) ? `step.${k}` : k, { key: k, map: null });
        }
    }
    return slots;
}

/** `{ messageId: …, prompt: … }`: every field of the step under its own name. */
export function stepBindings(draft: Draft): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, s] of slotsOf(draft)) out[name] = s.map ? (draft[s.map] as Record<string, unknown>)[s.key] : draft[s.key];
    return out;
}

/** Write rebound slots back: one `set` per top-level key that changed. */
export function applyStepBindings(draft: Draft, next: Record<string, unknown>, set: (key: string, value: unknown) => void): void {
    const changed = new Map<string, unknown>();
    for (const [name, s] of slotsOf(draft)) {
        if (!(name in next)) continue;
        const before = s.map ? (draft[s.map] as Record<string, unknown>)[s.key] : draft[s.key];
        if (next[name] === before) continue;
        if (!s.map) { changed.set(s.key, next[name]); continue; }
        const map = (changed.get(s.map) as Record<string, unknown> | undefined) || { ...(draft[s.map] as Record<string, unknown>) };
        map[s.key] = next[name];
        changed.set(s.map, map);
    }
    for (const [k, v] of changed) set(k, v);
}

/**
 * Record the gates of a GUI entry by RUNNING them, for the inventory goldens.
 *
 * probeGate: a gate is a function of a context (`({ hasPermission, can }) => …`,
 * `(facts) => facts.projects`). It is called with a recording context: every
 * call of a named function (`hasPermission('manage_agents')`), every
 * `<list>.includes(x)` and every other property read is a LEG, answered from an
 * assignment (true unless set). The legs are found by running the gate on every
 * assignment of the legs found so far, until no new one appears; the result is
 * the gate's truth table over its legs, written as compactly as it allows:
 *
 *   ['hasPermission(manage_skills)', 'can(skills)']   all of these (an AND, in evaluation order)
 *   ['!isSelfHosted']                                 a negated leg
 *   { any: ['isPlatformAdmin', 'isHomeOrgAdmin'] }     one of these (an OR)
 *   { legs: [...], table: '0001…' }                   anything else (row i: leg k is true when bit k of i is 1)
 *   []                                                no gate (always true); false: never
 *
 * probeOptions: a builder that takes an options object and returns rows. Each
 * boolean option is flipped and each object option set to null, one at a time;
 * a row that disappears is gated by that option (`showApprovals`, or
 * `!isMobile` when it disappears as the option turns true).
 */

type Gate = string[] | { any: string[] } | { legs: string[]; table: string } | false;

interface ProbeShape {
    /** Context properties that are functions: each call is a leg `name(arg)`. */
    calls?: readonly string[];
    /** Context properties that are lists: each `includes(x)` is a leg `name.includes(x)`. */
    lists?: readonly string[];
}

function recordingContext(shape: ProbeShape, value: (leg: string) => boolean, seen: string[]): object {
    const note = (leg: string) => {
        if (!seen.includes(leg)) seen.push(leg);
        return value(leg);
    };
    return new Proxy({}, {
        get(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            if (shape.calls?.includes(prop)) return (arg: unknown) => note(`${prop}(${String(arg)})`);
            if (shape.lists?.includes(prop)) return { includes: (x: unknown) => note(`${prop}.includes(${String(x)})`) };
            return note(prop);
        },
    });
}

const MAX_LEGS = 10;

/** Run the gate on every assignment of its legs; the legs (in evaluation order) and the table. */
function truthTable(fn: (ctx: never) => unknown, shape: ProbeShape): { legs: string[]; table: string } {
    const legs: string[] = [];
    for (;;) {
        const known = legs.length;
        if (known > MAX_LEGS) throw new Error(`a gate with more than ${MAX_LEGS} legs: ${legs.join(', ')}`);
        let table = '';
        for (let row = 0; row < 2 ** known; row++) {
            const value = (leg: string) => {
                const at = legs.indexOf(leg);
                return at < 0 || at >= known ? true : !!(row & (1 << at));
            };
            table += fn(recordingContext(shape, value, legs) as never) ? '1' : '0';
        }
        if (legs.length === known) return { legs, table };
    }
}

/** The literals of the one row of a table that differs from all the others, else null. */
function singleRow(legs: string[], table: string, bit: '0' | '1'): string[] | null {
    const rows = [...table].flatMap((b, i) => (b === bit ? [i] : []));
    if (rows.length !== 1) return null;
    return legs.map((leg, k) => ((rows[0] & (1 << k)) ? leg : `!${leg}`));
}

/** The gate of a function of a context, as described above. */
export function probeGate(fn: (ctx: never) => unknown, shape: ProbeShape = {}): Gate {
    const { legs, table } = truthTable(fn, shape);
    if (!table.includes('0')) return [];
    if (!table.includes('1')) return false;
    const and = singleRow(legs, table, '1');
    if (and) return and;
    const orRow = singleRow(legs, table, '0');
    if (orRow) return { any: orRow.map((l) => (l.startsWith('!') ? l.slice(1) : `!${l}`)) };
    return { legs, table };
}

/** Which options gate which rows of a builder: row key -> the options it needs. */
export function probeOptions<O extends object, R>(build: (o: O) => R[], base: O, keyOf: (row: R) => string): Record<string, string[]> {
    const present = new Set(build(base).map(keyOf));
    const gates: Record<string, string[]> = {};
    for (const [name, v] of Object.entries(base)) {
        let flipped: unknown;
        if (typeof v === 'boolean') flipped = !v;
        else if (v && typeof v === 'object') flipped = null;
        else continue;
        const now = new Set(build({ ...base, [name]: flipped }).map(keyOf));
        for (const key of present) {
            if (!now.has(key)) (gates[key] ??= []).push(v === false ? `!${name}` : name);
        }
    }
    return gates;
}

/** A label function that answers its key, so a row records the i18n key it shows. */
export const keyT = (key: string): string => key;

/** The identity of an icon: a lucide component's name, an emoji or glyph as it is, else the kind of value. */
export function iconId(icon: unknown): string | null {
    if (icon == null) return null;
    if (typeof icon === 'string') return icon;
    const element = icon as { $$typeof?: symbol; type?: unknown };
    if (element.$$typeof && element.type) return typeof element.type === 'string' ? `<${element.type}>` : iconId(element.type);
    const named = icon as { displayName?: string; name?: string; render?: { name?: string } };
    if (named.displayName) return named.displayName;
    if (named.render?.name) return named.render.name;
    if (named.name) return named.name;
    return typeof icon;
}
